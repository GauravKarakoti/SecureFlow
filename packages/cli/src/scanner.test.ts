/**
 * Tests for the pre-commit detector (#593).
 *
 * The wrapped-call and template-interpolation cases are the ones that used to
 * be undetectable: the old scanner tested one line at a time, so the `[\s\S]*?`
 * in its pattern could never span anything, and its string-stripping step
 * deleted template literals along with their interpolations.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  isSecretIdentifier,
  MAX_SCANNED_BYTES,
  blockingAiFindings,
  describeFailThreshold,
  findSecretLogging,
  formatScanResults,
  lineOf,
  looksBinary,
  maskStringLiterals,
  parseFailOnArg,
  readArgumentList,
  scanFile,
  shouldFailScan,
  shouldScanFile,
  generateVoiceSummaryText,
  countFindingsBySeverity,
  formatSeverityCounts,
} from "./scanner.js";
import { CliUsageError, parseVoiceArg } from "./lib/output-args.js";
import { generateSarifReport, validateSarifDocument } from "./sarif.js";
import { QNX_RULES } from "./qnx-ddk-rules.js";
import { formatTuiScanSummary } from "./lib/tui.js";
import {
  isNonInteractiveCiEnvironment,
  getOsAudioCommand,
  playAudioFile,
} from "./lib/audio-player.js";

const source = (...lines: string[]) => lines.join("\n");

describe("maskStringLiterals", () => {
  it("blanks a literal but preserves its length", () => {
    // Length matters now that whole files are scanned: deleting shifts every
    // offset after it, and the reported line number comes from an offset.
    const input = 'const a = "hello";';
    const masked = maskStringLiterals(input);

    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain("hello");
    expect(masked.startsWith('const a = "')).toBe(true);
  });

  it.each(['"', "'", "`"])("handles a %s-quoted literal", (quote) => {
    expect(maskStringLiterals(`x = ${quote}password${quote}`)).not.toContain("password");
  });

  it("keeps a template interpolation visible", () => {
    // The old `replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, '')` deleted the whole
    // literal including `${authToken}`, leaving `console.log()` — so the single
    // most common way a secret reaches a log line matched nothing.
    const masked = maskStringLiterals("console.log(`token: ${authToken}`)");

    expect(masked).toContain("authToken");
    expect(masked).not.toContain("token: ");
  });

  it("tracks brace depth inside an interpolation", () => {
    const masked = maskStringLiterals("`${ fn({ a: 1 }) } tail`");

    expect(masked).toContain("fn({ a: 1 })");
    expect(masked).not.toContain("tail");
  });

  it("does not let an escaped quote end a literal", () => {
    const masked = maskStringLiterals('const a = "he said \\"secret\\""; const b = password;');

    expect(masked).not.toContain("secret");
    expect(masked).toContain("password");
  });

  it("stops an unterminated single quote at the newline", () => {
    // Otherwise one stray apostrophe blinds the scanner to the rest of the file.
    const masked = maskStringLiterals(source("const a = 'oops", "console.log(process.env.KEY)"));

    expect(masked).toContain("process.env.KEY");
  });

  it("lets a template literal span lines", () => {
    const masked = maskStringLiterals(source("const a = `line one", "line two`;"));

    expect(masked).not.toContain("line two");
  });

  it("masks line and block comments", () => {
    // The old code only skipped `//` at the start of a trimmed line, so a
    // trailing comment was scanned as code.
    const masked = maskStringLiterals("const a = 1; // password = secret");

    expect(masked).not.toContain("password");
    expect(maskStringLiterals("/* password */ const a = 1;")).not.toContain("password");
  });

  it("preserves newlines so line numbers survive", () => {
    const input = source('const a = "x";', 'const b = "y";', "const c = 1;");
    const masked = maskStringLiterals(input);

    expect(masked.split("\n")).toHaveLength(3);
  });
});

describe("readArgumentList", () => {
  it("returns the balanced argument text", () => {
    expect(readArgumentList("console.log(a, b)", 11)).toBe("a, b");
  });

  it("handles nested parentheses", () => {
    expect(readArgumentList("console.log(fn(a, b), c)", 11)).toBe("fn(a, b), c");
  });

  it("returns null for an unclosed call", () => {
    expect(readArgumentList("console.log(a, b", 11)).toBeNull();
  });
});

describe("lineOf", () => {
  it("is 1-based", () => {
    expect(lineOf("a\nb\nc", 0)).toBe(1);
    expect(lineOf("a\nb\nc", 2)).toBe(2);
    expect(lineOf("a\nb\nc", 4)).toBe(3);
  });
});

describe("findSecretLogging — detection", () => {
  it("flags a direct process.env log", () => {
    const found = findSecretLogging("console.log(process.env.AWS_SECRET_ACCESS_KEY);");

    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(1);
    expect(found[0].reason).toBe("environment variable");
  });

  it("flags a wrapped call spanning several lines", () => {
    // The shape Prettier produces at default print width, and the shape the
    // old line-by-line scanner could never match.
    const found = findSecretLogging(
      source("console.log(", "  'db password:',", "  process.env.DB_PASSWORD", ");"),
    );

    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(1);
  });

  it("flags a secret reaching the log through a template interpolation", () => {
    const found = findSecretLogging("console.log(`auth token: ${authToken}`);");

    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("secret-named identifier");
  });

  it("flags a secret-named variable", () => {
    expect(findSecretLogging("console.error(dbPassword);")).toHaveLength(1);
    expect(findSecretLogging("console.warn(userCredentials);")).toHaveLength(1);
  });

  it.each(["log", "info", "warn", "error", "debug", "trace", "table", "dir"])(
    "covers console.%s",
    (method) => {
      expect(findSecretLogging(`console.${method}(process.env.KEY);`)).toHaveLength(1);
    },
  );

  it("tolerates whitespace a formatter may introduce", () => {
    expect(findSecretLogging("console . log ( process.env.KEY );")).toHaveLength(1);
  });

  it("reports every violation in a file, not just the first", () => {
    const found = findSecretLogging(
      source("console.log(process.env.A);", "const x = 1;", "console.log(apiSecret);"),
    );

    expect(found.map((v) => v.line)).toEqual([1, 3]);
  });

  it("reports the line the call starts on", () => {
    const found = findSecretLogging(
      source("const x = 1;", "const y = 2;", "console.log(", "  process.env.KEY,", ");"),
    );

    expect(found[0].line).toBe(3);
    expect(found[0].text).toBe("console.log(");
  });
});

describe("findSecretLogging — restraint", () => {
  it("does not flag a string that merely mentions a secret", () => {
    // Masking is what makes this work: the word only exists inside a literal.
    expect(findSecretLogging('console.log("enter your password to continue");')).toHaveLength(0);
  });

  it("does not flag a commented-out call", () => {
    expect(findSecretLogging("// console.log(process.env.SECRET);")).toHaveLength(0);
    expect(findSecretLogging("/* console.log(process.env.SECRET); */")).toHaveLength(0);
  });

  it("does not flag a non-console call", () => {
    expect(findSecretLogging("logger.info(process.env.SECRET);")).toHaveLength(0);
  });

  it("does not flag ordinary code with no console call", () => {
    expect(findSecretLogging("const password = process.env.DB_PASSWORD;")).toHaveLength(0);
  });

  it("does not flag `key` used as an ordinary word", () => {
    // `key` and `auth` alone are too common in normal code — keyof, keys,
    // authorised — so they only count as a whole word or an obvious compound.
    expect(findSecretLogging("console.log(Object.keys(config));")).toHaveLength(0);
    expect(findSecretLogging("console.log(monkeypatch);")).toHaveLength(0);
  });

  it("returns nothing for empty input", () => {
    expect(findSecretLogging("")).toEqual([]);
  });

  it("does not hang on an unclosed call at end of file", () => {
    expect(findSecretLogging("console.log(process.env.KEY")).toEqual([]);
  });
});

describe("shouldScanFile", () => {
  it.each(["logo.png", "font.woff2", "bundle.wasm", "archive.tar.gz"])("skips %s", (path) => {
    expect(shouldScanFile(path)).toBe(false);
  });

  it.each(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"])(
    "skips the generated file %s",
    (path) => {
      expect(shouldScanFile(`some/dir/${path}`)).toBe(false);
    },
  );

  it("scans ordinary source", () => {
    expect(shouldScanFile("src/lib/armor/scanner.ts")).toBe(true);
    expect(shouldScanFile(".env.example")).toBe(true);
  });

  it("skips a blob over the size ceiling", () => {
    expect(shouldScanFile("src/big.ts", MAX_SCANNED_BYTES + 1)).toBe(false);
    expect(shouldScanFile("src/big.ts", MAX_SCANNED_BYTES)).toBe(true);
  });

  it("is case-insensitive about extensions", () => {
    expect(shouldScanFile("Logo.PNG")).toBe(false);
  });
});

describe("looksBinary", () => {
  it("detects a NUL byte", () => {
    expect(looksBinary("abc\u0000def")).toBe(true);
  });

  it("does not flag ordinary text", () => {
    expect(looksBinary("const a = 1;\n")).toBe(false);
  });
});

describe("scanFile", () => {
  it("reports violations for a scannable file", () => {
    const result = scanFile("src/debug.ts", "console.log(process.env.SECRET);");

    expect(result.path).toBe("src/debug.ts");
    expect(result.violations).toHaveLength(1);
    expect(result.skipped).toBeUndefined();
  });

  it("skips an excluded file and says why", () => {
    const result = scanFile("logo.png", "console.log(process.env.SECRET);");

    expect(result.violations).toEqual([]);
    expect(result.skipped).toBe("excluded by type or size");
  });

  it("skips binary content that slipped past the extension list", () => {
    const result = scanFile("src/data.ts", "console.log(process.env.S);\u0000\u0000");

    expect(result.skipped).toBe("binary content");
  });
});

describe("formatScanResults", () => {
  it("formats results as markdown when format is 'markdown'", () => {
    const result = scanFile("src/debug.ts", "console.log(process.env.SECRET);");
    const output = formatScanResults([result], "markdown");

    expect(output).toContain("# 🛡️ SecureFlow Scan Report");
    expect(output).toContain("| File | Line | Violation | Reason |");
    expect(output).toContain("src/debug.ts");
    expect(output).toContain("environment variable");
  });
});

describe("parseFailOnArg", () => {
  it("parses --fail-on=SEVERITY syntax", () => {
    expect(parseFailOnArg(["node", "index.js", "--fail-on=HIGH"])).toBe("HIGH");
    expect(parseFailOnArg(["node", "index.js", "--fail-on=CRITICAL"])).toBe("CRITICAL");
    expect(parseFailOnArg(["node", "index.js", "--fail-on=medium"])).toBe("MEDIUM");
  });

  it("parses --fail-on SEVERITY separate argument syntax", () => {
    expect(parseFailOnArg(["node", "index.js", "--fail-on", "CRITICAL"])).toBe("CRITICAL");
    expect(parseFailOnArg(["node", "index.js", "--fail-on", "low"])).toBe("LOW");
  });

  it("returns null when --fail-on is not specified", () => {
    expect(parseFailOnArg(["node", "index.js"])).toBeNull();
  });

  it("throws a usage error for an unrecognised --fail-on= value", () => {
    expect(() => parseFailOnArg(["node", "index.js", "--fail-on=INVALID"])).toThrow(CliUsageError);
    expect(() => parseFailOnArg(["node", "index.js", "--fail-on=INVALID"])).toThrow(
      'Unknown --fail-on value "INVALID"',
    );
  });

  it("throws a usage error when --fail-on has no valid following value", () => {
    expect(() => parseFailOnArg(["node", "index.js", "--fail-on"])).toThrow(CliUsageError);
    expect(() => parseFailOnArg(["node", "index.js", "--fail-on"])).toThrow(
      "--fail-on requires a value",
    );
    expect(() => parseFailOnArg(["node", "index.js", "--fail-on", "bogus"])).toThrow(
      'Unknown --fail-on value "bogus"',
    );
  });
});

describe("shouldFailScan", () => {
  it("defaults to failing on local violations or HIGH/CRITICAL AI findings when failOnThreshold is null", () => {
    expect(shouldFailScan(1, [], null)).toBe(true);
    expect(shouldFailScan(0, [{ severity: "HIGH" }], null)).toBe(true);
    expect(shouldFailScan(0, [{ severity: "LOW" }], null)).toBe(false);
  });

  it("matches the default gate on severity case-insensitively", () => {
    // The AI response is cast, not validated, so a lowercase "high" finding
    // must still block under the default HIGH/CRITICAL gate.
    expect(shouldFailScan(0, [{ severity: "high" }], null)).toBe(true);
    expect(shouldFailScan(0, [{ severity: "Critical" }], null)).toBe(true);
    expect(shouldFailScan(0, [{ severity: "medium" }], null)).toBe(false);
  });

  it("fails when local violations (HIGH) meet or exceed threshold", () => {
    expect(shouldFailScan(1, [], "HIGH")).toBe(true);
    expect(shouldFailScan(1, [], "LOW")).toBe(true);
    expect(shouldFailScan(1, [], "CRITICAL")).toBe(false);
  });

  it("never fails the scan when the threshold is NONE", () => {
    // NONE is in the accepted set for --fail-on, so it has to mean "report but
    // do not block" — advisory mode. Ranking it at 0 made every finding clear
    // the bar instead, which is the exact inverse.
    expect(shouldFailScan(0, [{ severity: "CRITICAL" }], "NONE")).toBe(false);
    expect(shouldFailScan(0, [{ severity: "LOW" }], "NONE")).toBe(false);
    expect(shouldFailScan(5, [], "NONE")).toBe(false);
    expect(shouldFailScan(5, [{ severity: "CRITICAL" }], "NONE")).toBe(false);
  });

  it("does not fail a clean scan at any threshold", () => {
    for (const threshold of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"] as const) {
      expect(shouldFailScan(0, [], threshold)).toBe(false);
    }
  });

  it("fails when AI findings meet or exceed threshold", () => {
    expect(shouldFailScan(0, [{ severity: "CRITICAL" }], "CRITICAL")).toBe(true);
    expect(shouldFailScan(0, [{ severity: "HIGH" }], "CRITICAL")).toBe(false);
    expect(shouldFailScan(0, [{ severity: "MEDIUM" }], "MEDIUM")).toBe(true);
    expect(shouldFailScan(0, [{ severity: "LOW" }], "MEDIUM")).toBe(false);
  });
});

describe("blockingAiFindings", () => {
  const findings = [
    { severity: "CRITICAL" },
    { severity: "HIGH" },
    { severity: "MEDIUM" },
    { severity: "LOW" },
  ];

  it("returns the HIGH/CRITICAL findings when no threshold is set", () => {
    expect(blockingAiFindings(findings, null)).toEqual([
      { severity: "CRITICAL" },
      { severity: "HIGH" },
    ]);
  });

  it("matches severity case-insensitively when no threshold is set", () => {
    expect(blockingAiFindings([{ severity: "high" }, { severity: "low" }], null)).toEqual([
      { severity: "high" },
    ]);
  });

  it("returns every finding at or above an explicit threshold", () => {
    expect(blockingAiFindings(findings, "MEDIUM")).toHaveLength(3);
    // A single LOW finding is what blocks under --fail-on=LOW, so the message
    // has something to report other than "0 secret-logging violations".
    expect(blockingAiFindings([{ severity: "LOW" }], "LOW")).toHaveLength(1);
    expect(blockingAiFindings(findings, "CRITICAL")).toEqual([{ severity: "CRITICAL" }]);
  });

  it("blocks on nothing under NONE", () => {
    expect(blockingAiFindings(findings, "NONE")).toEqual([]);
  });

  it("agrees with shouldFailScan about the AI findings", () => {
    for (const threshold of [null, "CRITICAL", "HIGH", "MEDIUM", "LOW"] as const) {
      expect(blockingAiFindings(findings, threshold).length > 0).toBe(
        shouldFailScan(0, findings, threshold),
      );
    }
  });

  it("treats an unrecognised severity as LOW rather than dropping it", () => {
    expect(blockingAiFindings([{ severity: "" }], "LOW")).toHaveLength(1);
    expect(blockingAiFindings([{ severity: "critical" }], "CRITICAL")).toHaveLength(1);
  });
});

describe("describeFailThreshold", () => {
  it("names the flag only when the user passed it", () => {
    expect(describeFailThreshold("LOW")).toBe("the --fail-on=LOW threshold");
    // Previously this interpolated a null threshold straight into the summary,
    // which read "below --fail-on=null threshold".
    expect(describeFailThreshold(null)).toBe("the default HIGH/CRITICAL threshold");
    expect(describeFailThreshold(null)).not.toContain("null");
  });
});

describe("countFindingsBySeverity and formatSeverityCounts", () => {
  it("counts zero findings when none exist", () => {
    const counts = countFindingsBySeverity(0, []);
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(formatSeverityCounts(counts)).toBe(
      "Findings by severity: critical: 0, high: 0, medium: 0, low: 0",
    );
  });

  it("counts local violations as high severity", () => {
    const counts = countFindingsBySeverity(3, []);
    expect(counts).toEqual({ critical: 0, high: 3, medium: 0, low: 0 });
  });

  it("aggregates local violations and AI findings across all severities case-insensitively", () => {
    const aiFindings = [
      { severity: "CRITICAL" },
      { severity: "critical" },
      { severity: "HIGH" },
      { severity: "medium" },
      { severity: "LOW" },
      { severity: "low" },
    ];
    const counts = countFindingsBySeverity(1, aiFindings);
    expect(counts).toEqual({ critical: 2, high: 2, medium: 1, low: 2 });
    expect(formatSeverityCounts(counts)).toBe(
      "Findings by severity: critical: 2, high: 2, medium: 1, low: 2",
    );
  });
});

describe("secret-named identifiers", () => {
  const flagged = (code: string) => scanFile("a.ts", code + "\n", []).violations.length > 0;

  it.each([
    "console.log(private_key);",
    "console.log(PRIVATE_KEY);",
    "console.log(privateKey);",
    "console.log(passphrase);",
    "console.log(gpg_passphrase);",
    "console.log(signing_key);",
    "console.log(encryptionKey);",
    "console.log(password);",
    "console.log(authToken);",
    "console.log(tokens);",
    "console.log(passwordLength);",
  ])("flags %s", (code) => {
    expect(flagged(code)).toBe(true);
  });

  it.each([
    "console.log(tokenizer);",
    "console.log(maxTokens);",
    "console.log(usage.totalTokens, usage.promptTokens);",
    "console.log(completion_tokens);",
    "console.log(tokenCount);",
    "console.log(tokenUsage);",
    "console.log(tokenized);",
  ])("does not flag token counts or tokenizers: %s", (code) => {
    // `token` as a bare substring used to flag every one of these.
    expect(flagged(code)).toBe(false);
  });

  it("still flags a secret logged alongside a token count", () => {
    expect(flagged("console.log(maxTokens, apiToken);")).toBe(true);
  });

  it("normalizes separators and case", () => {
    expect(isSecretIdentifier("PRIVATE-KEY")).toBe(true);
    expect(isSecretIdentifier("private_key")).toBe(true);
    expect(isSecretIdentifier("MAX_TOKENS")).toBe(false);
    expect(isSecretIdentifier("authorName")).toBe(false);
  });
});

describe("generateVoiceSummaryText", () => {
  it("generates a clean pass message when zero findings exist", () => {
    const text = generateVoiceSummaryText(0, [], true);
    expect(text).toContain("Zero secret exposures");
    expect(text).toContain("passed cleanly");
  });

  it("generates an alert message when scan fails with local violations", () => {
    const text = generateVoiceSummaryText(2, [], false);
    expect(text).toContain("Security alert");
    expect(text).toContain("2 secret-logging violations");
  });

  it("generates an alert message with AI findings", () => {
    const text = generateVoiceSummaryText(1, [{ severity: "HIGH" }], false);
    expect(text).toContain("1 secret-logging violation and 1 AI-detected finding");
  });

  it("generates an advisory warning when scan passes with findings", () => {
    const text = generateVoiceSummaryText(1, [{ severity: "LOW" }], true);
    expect(text).toContain("advisory warning");
    expect(text).toContain("Scan passed below blocking threshold");
  });
});

describe("voice flag and audio player integration", () => {
  it("parses --voice and -v flags", () => {
    expect(parseVoiceArg(["node", "cli", "--voice"])).toBe(true);
    expect(parseVoiceArg(["node", "cli", "-v"])).toBe(true);
    expect(parseVoiceArg(["node", "cli", "--voice=true"])).toBe(true);
    expect(parseVoiceArg(["node", "cli", "--voice=false"])).toBe(false);
    expect(parseVoiceArg(["node", "cli"])).toBe(false);
  });

  it("detects CI environment to gracefully bypass audio playback", () => {
    expect(isNonInteractiveCiEnvironment({ CI: "true", NODE_ENV: "test" })).toBe(true);
    expect(isNonInteractiveCiEnvironment({ GITHUB_ACTIONS: "true", NODE_ENV: "test" })).toBe(true);
    expect(
      isNonInteractiveCiEnvironment({ CI: "false", GITHUB_ACTIONS: undefined, NODE_ENV: "test" }),
    ).toBe(false);

    const res = playAudioFile("test.mp3", { env: { CI: "true", NODE_ENV: "test" } });
  });

  it("resolves appropriate OS audio playback command per platform", () => {
    expect(getOsAudioCommand("test.mp3", "darwin")?.command).toBe("afplay");
    expect(getOsAudioCommand("test.mp3", "win32")?.command).toBe("powershell");
    expect(getOsAudioCommand("test.mp3", "linux")?.command).toBe("mpg123");
  });

  it("bypasses audio playback in CI environment gracefully", () => {
    const res = playAudioFile("test.mp3", { env: { CI: "true", NODE_ENV: "test" } });
    expect(res.played).toBe(false);
    expect(res.bypassed).toBe(true);
  });
});

describe("entropy and benign secret false positive suppression (#1512)", () => {
  it("does not flag benign placeholder tokens and mock keys", () => {
    const benignCases = [
      "console.log(your_api_key_here);",
      "console.log(mock_api_key);",
      "console.info(mock_token);",
      "console.warn(placeholder_token);",
      "console.error(dummy_secret);",
      "console.log(test_token);",
      "console.log(sample_secret);",
      "console.log(fake_api_key);",
      "console.debug(example_token);",
      "console.log(changeme);",
    ];

    for (const code of benignCases) {
      expect(findSecretLogging(code)).toEqual([]);
    }
  });

  it("does not flag UUID strings or standard UUID variables", () => {
    const uuidCode = `
      const transactionId = "123e4567-e89b-12d3-a456-426614174000";
      console.log(transactionId);
    `;
    expect(findSecretLogging(uuidCode)).toEqual([]);
  });

  it("still flags actual high-risk secret identifiers", () => {
    const secretCases = [
      "console.log(stripeApiKey);",
      "console.error(clientSecret);",
      "console.warn(jwtAuthToken);",
      "console.log(production_private_key);",
      "console.log(database_password);",
    ];

    for (const code of secretCases) {
      const violations = findSecretLogging(code);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].reason).toBe("secret-named identifier");
    }
  });
});

describe("QNX driver and real-time C/C++ rules (#2211)", () => {
  const RESMGR_HEADERS = [
    "#include <devctl.h>",
    "#include <sys/iofunc.h>",
    "#include <sys/resmgr.h>",
    "#include <sys/neutrino.h>",
  ];

  const cFile = (...lines: string[]) => source(...RESMGR_HEADERS, ...lines);
  const findings = (code: string, path = "driver.c") => scanFile(path, code).violations;
  const ruleIds = (code: string, path = "driver.c") => findings(code, path).map((v) => v.ruleId);

  const VULNERABLE_DRIVER = cFile(
    "static char shared[64];",
    "",
    "int io_devctl(resmgr_context_t *ctp, io_devctl_t *msg, iofunc_ocb_t *ocb) {",
    "  void *data = _IO_INPUT_PAYLOAD(msg);",
    "  memcpy(shared, data, msg->i.nbytes);",
    "  return EOK;",
    "}",
    "",
    "int io_write(resmgr_context_t *ctp, io_write_t *msg, RESMGR_OCB_T *ocb) {",
    "  size_t n = msg->i.nbytes;",
    "  char *buf = malloc(n + 1);",
    "  resmgr_msgread(ctp, buf, n, sizeof(msg->i));",
    "  return ctp->info.msglen;",
    "}",
  );

  const CLEAN_DRIVER = cFile(
    "#define MAX_PAYLOAD 64",
    "static char shared[MAX_PAYLOAD];",
    "",
    "int io_devctl(resmgr_context_t *ctp, io_devctl_t *msg, iofunc_ocb_t *ocb) {",
    "  size_t payload = sizeof(shared);",
    "  if (ctp->size < sizeof(msg->i) + payload) return EBADMSG;",
    "  memcpy(shared, _IO_INPUT_PAYLOAD(msg), payload);",
    "  return EOK;",
    "}",
    "",
    "int io_write(resmgr_context_t *ctp, io_write_t *msg, RESMGR_OCB_T *ocb) {",
    "  size_t n = msg->i.nbytes;",
    "  if (n > MAX_PAYLOAD) return EMSGSIZE;",
    "  char *buf = malloc(n + 1);",
    "  if (buf == NULL) return ENOMEM;",
    "  if (resmgr_msgget(ctp, buf, n, sizeof(msg->i)) != n) return EBADMSG;",
    '  snprintf(shared, sizeof(shared), "%s", buf);',
    "  free(buf);",
    "  return EOK;",
    "}",
    "",
    "int main(void) {",
    "  int id = resmgr_attach(dpp, &attr, path, _FTYPE_ANY, 0, &connect, &io, &ocb);",
    "  run(id);",
    "  resmgr_detach(dpp, id, 0);",
    "}",
  );

  it("flags the vulnerable resource manager sample", () => {
    expect(findings(VULNERABLE_DRIVER).map((v) => [v.ruleId, v.line])).toEqual([
      ["QNX-IOCTL-001", 8],
      ["QNX-IOCTL-002", 9],
      ["QNX-BOUNDS-001", 9],
      ["QNX-BOUNDS-002", 15],
      ["QNX-BOUNDS-001", 16],
      ["QNX-MSG-002", 17],
    ]);
  });

  it.each(["_IO_INPUT_PAYLOAD(msg)", "_DEVCTL_DATA(msg->i)"])(
    "requires a received-length check before %s",
    (macro) => {
      const handler = (...check: string[]) =>
        cFile(
          "int io_devctl(resmgr_context_t *ctp, io_devctl_t *msg, iofunc_ocb_t *ocb) {",
          ...check,
          `  uint32_t *rate = ${macro};`,
          "  return apply(*rate);",
          "}",
        );
      expect(ruleIds(handler())).toEqual(["QNX-IOCTL-001"]);
      expect(
        findings(
          handler(
            "  size_t payload_size = ctp->size - sizeof(msg->i);",
            "  if (payload_size < sizeof(uint32_t)) return EINVAL;",
          ),
        ),
      ).toEqual([]);
    },
  );

  it("passes the clean reference driver", () => {
    expect(findings(CLEAN_DRIVER)).toEqual([]);
  });

  describe("real-time paths", () => {
    const ist = (...loopBody: string[]) =>
      cFile(
        "void *ist(void *arg) {",
        "  char *scratch = malloc(32);",
        '  printf("starting\\n");',
        "  int id = InterruptAttachThread(irq, _NTO_INTR_FLAGS_NO_UNMASK);",
        "  while (1) {",
        "    InterruptWait(_NTO_INTR_WAIT_FLAGS_UNMASK, NULL);",
        ...loopBody,
        "  }",
        "  InterruptDetach(id);",
        "}",
      );

    it("flags allocation and blocking calls inside the interrupt thread loop only", () => {
      const code = ist("    void *p = malloc(16);", "    sleep(1);", "    free(p);");
      expect(findings(code).map((v) => [v.ruleId, v.line])).toEqual([
        ["QNX-RT-001", 11],
        ["QNX-RT-002", 12],
        ["QNX-RT-001", 13],
      ]);
    });

    it("accepts a loop that only talks to the device and sends a pulse", () => {
      const code = ist("    value = in32(base);", "    MsgSendPulse(coid, -1, 1, value);");
      expect(findings(code)).toEqual([]);
    });

    it("flags a spinlocked section", () => {
      const code = cFile(
        "void update(void) {",
        "  InterruptLock(&lock);",
        '  printf("locked\\n");',
        "  InterruptUnlock(&lock);",
        '  printf("unlocked\\n");',
        "}",
      );
      expect(findings(code).map((v) => [v.ruleId, v.line])).toEqual([["QNX-RT-002", 7]]);
    });

    it("checks functions marked secureflow:realtime", () => {
      const code = cFile(
        "/* secureflow:realtime */",
        "void control_step(void) {",
        "  MsgSend(coid, &out, sizeof(out), &in, sizeof(in));",
        "}",
        "void setup(void) {",
        "  buffer = calloc(1, 64);",
        "}",
      );
      expect(findings(code).map((v) => [v.ruleId, v.line])).toEqual([["QNX-RT-002", 7]]);
    });

    it("accepts MsgSend() after TimerTimeout()", () => {
      const code = cFile(
        "// secureflow:realtime",
        "void control_step(void) {",
        "  TimerTimeout(CLOCK_MONOTONIC, _NTO_TIMEOUT_SEND, NULL, &timeout, NULL);",
        "  MsgSend(coid, &out, sizeof(out), &in, sizeof(in));",
        "}",
      );
      expect(findings(code)).toEqual([]);
    });

    it("flags new and delete in C++ real-time code", () => {
      const code = cFile(
        "// secureflow:realtime",
        "void Controller::step() noexcept {",
        "  auto *sample = new Sample();",
        "  delete sample;",
        "}",
      );
      expect(ruleIds(code, "controller.cpp")).toEqual(["QNX-RT-001", "QNX-RT-001"]);
    });

    it("flags InterruptAttach(), which QNX 8.0 removed", () => {
      const code = cFile(
        "void setup(void) {",
        "  id = InterruptAttach(irq, isr, NULL, 0, 0);",
        "  InterruptDetach(id);",
        "}",
      );
      expect(ruleIds(code)).toEqual(["QNX-API-001"]);
    });
  });

  describe("message passing and mappings", () => {
    const server = (...lines: string[]) => cFile("void serve(int chid) {", ...lines, "}");

    it.each([
      ["a discarded result", ["  MsgReceive(chid, &msg, sizeof(msg), NULL);"]],
      [
        "a variable that is never compared",
        ["  int rcvid = MsgReceive(chid, &msg, sizeof(msg), NULL);", "  handle(&msg);"],
      ],
    ])("flags MsgReceive() with %s", (_label, lines) => {
      expect(ruleIds(server(...lines))).toEqual(["QNX-MSG-001"]);
    });

    it.each([
      [
        "compared on the next line",
        ["  rcvid = MsgReceive(chid, &msg, sizeof(msg), NULL);", "  if (rcvid == -1) return;"],
      ],
      [
        "compared in the condition",
        ["  if ((rcvid = MsgReceive(chid, &msg, sizeof(msg), NULL)) == -1) return;"],
      ],
      [
        "switched on",
        ["  rcvid = MsgReceive(chid, &msg, sizeof(msg), NULL);", "  switch (rcvid) { }"],
      ],
    ])("accepts a MsgReceive() result %s", (_label, lines) => {
      expect(findings(server(...lines))).toEqual([]);
    });

    it("flags an unchecked device mapping and a NULL comparison", () => {
      const code = cFile(
        "void map(void) {",
        "  regs = mmap_device_memory(NULL, 4096, PROT_READ, 0, PHYS);",
        "  if (regs == NULL) return;",
        "  munmap_device_memory(regs, 4096);",
        "}",
      );
      expect(ruleIds(code)).toEqual(["QNX-MEM-001"]);
    });

    it("accepts mappings compared with the documented failure values", () => {
      const code = cFile(
        "void map(void) {",
        "  regs = mmap_device_memory(NULL, 4096, PROT_READ, 0, PHYS);",
        "  if (regs == MAP_FAILED) return;",
        "  port = mmap_device_io(8, 0x3f8);",
        "  if ((uintptr_t)MAP_DEVICE_FAILED == port) return;",
        "  munmap_device_io(port, 8);",
        "  munmap_device_memory(regs, 4096);",
        "}",
      );
      expect(findings(code)).toEqual([]);
    });

    it("reports a missing release as LOW so it does not block by default", () => {
      const code = cFile("void start(void) {", '  att = name_attach(NULL, "svc", 0);', "}");
      const [violation] = findings(code);
      expect(violation?.ruleId).toBe("QNX-RES-001");
      expect(violation?.severity).toBe("LOW");
      expect(shouldFailScan(findings(code), [])).toBe(false);
      // The release may live in the .c file that includes this header
      expect(findings(code, "driver.h")).toEqual([]);
    });
  });

  describe("bounds and string handling", () => {
    it("flags unbounded string functions but not literals or fixed formats", () => {
      const code = cFile(
        "void copy(char *out, const char *in, int n) {",
        "  strcpy(out, in);",
        '  strcpy(out, "ready");',
        '  sprintf(out, "%d", n);',
        '  sprintf(out, "%.8s", in);',
        '  sprintf(out, "%s", in);',
        "  gets(out);",
        "}",
      );
      expect(findings(code).map((v) => [v.ruleId, v.line])).toEqual([
        ["QNX-BOUNDS-003", 6],
        ["QNX-BOUNDS-003", 10],
        ["QNX-BOUNDS-003", 11],
      ]);
    });

    it("does not treat sizeof(msg->i.field) as a client supplied length", () => {
      const code = cFile(
        "int io_msg(resmgr_context_t *ctp, io_msg_t *msg) {",
        "  memcpy(name, msg->i.name, sizeof(msg->i.name));",
        "  return EOK;",
        "}",
      );
      expect(findings(code)).toEqual([]);
    });
  });

  describe("scope", () => {
    it("leaves C code without QNX headers or APIs alone", () => {
      const code = source(
        "#include <string.h>",
        "void copy(char *out, const char *in) { strcpy(out, in); }",
      );
      expect(findings(code)).toEqual([]);
    });

    it("ignores comments, strings and macros", () => {
      const code = cFile(
        "#define COPY(a, b) strcpy(a, b)",
        "// strcpy(a, b);",
        "/* gets(buffer); */",
        'const char *help = "never call gets(buffer)";',
        "long big = 1'000'000; void f(void) { }",
      );
      expect(findings(code)).toEqual([]);
    });

    it("does not run on other file types", () => {
      expect(findings(VULNERABLE_DRIVER, "notes.txt")).toEqual([]);
    });

    it("honours inline suppressions by rule id", () => {
      const code = cFile(
        "void copy(char *out, const char *in) {",
        "  // secureflow-ignore[rule=QNX-BOUNDS-003]: length checked by the caller",
        "  strcpy(out, in);",
        "}",
      );
      const result = scanFile("driver.c", code);
      expect(result.violations).toEqual([]);
      expect(result.suppressedViolations).toHaveLength(1);
    });

    it("handles many unbalanced braces quickly", () => {
      const code = cFile("void f() {\n".repeat(20000));
      expect(findings(code)).toEqual([]);
    });
  });

  describe("reporting", () => {
    const results = () => [scanFile("src/driver.c", VULNERABLE_DRIVER)];

    it("exports valid SARIF with one rule per id and a policy link", () => {
      const sarif = generateSarifReport(results());
      expect(validateSarifDocument(sarif).errors).toEqual([]);
      const run = sarif.runs[0]!;
      expect(run.results).toHaveLength(6);
      expect(run.tool.driver.rules.map((r) => r.id).sort()).toEqual([
        "CUSTOM-QNX-BOUNDS-001",
        "CUSTOM-QNX-BOUNDS-002",
        "CUSTOM-QNX-IOCTL-001",
        "CUSTOM-QNX-IOCTL-002",
        "CUSTOM-QNX-MSG-002",
      ]);
      expect(run.tool.driver.rules[0]!.helpUri).toContain("/docs/policies/");
      expect(run.results[0]!.level).toBe("error");
      expect(run.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
        "src/driver.c",
      );
    });

    it("shows the rule id in text and table output", () => {
      expect(formatScanResults(results(), "text")).toContain("[Custom Rule: QNX-IOCTL-001]");
      expect(formatTuiScanSummary(results())).toContain("QNX-IOCTL-001");
    });

    it("points every rule at a policy page that documents it", () => {
      const policyDir = path.resolve(__dirname, "../../../docs/policies");
      for (const qnxRule of Object.values(QNX_RULES)) {
        const page = fs.readFileSync(path.join(policyDir, qnxRule.policy), "utf-8");
        expect(page).toContain(qnxRule.id);
      }
    });
  });
});
