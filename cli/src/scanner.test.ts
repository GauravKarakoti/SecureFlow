/**
 * Tests for the pre-commit detector (#593).
 *
 * The wrapped-call and template-interpolation cases are the ones that used to
 * be undetectable: the old scanner tested one line at a time, so the `[\s\S]*?`
 * in its pattern could never span anything, and its string-stripping step
 * deleted template literals along with their interpolations.
 */
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
} from "./scanner.js";

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

  it("returns null when --fail-on is not specified or invalid", () => {
    expect(parseFailOnArg(["node", "index.js"])).toBeNull();
    expect(parseFailOnArg(["node", "index.js", "--fail-on=INVALID"])).toBeNull();
  });
});

describe("shouldFailScan", () => {
  it("defaults to failing on local violations or HIGH/CRITICAL AI findings when failOnThreshold is null", () => {
    expect(shouldFailScan(1, [], null)).toBe(true);
    expect(shouldFailScan(0, [{ severity: "HIGH" }], null)).toBe(true);
    expect(shouldFailScan(0, [{ severity: "LOW" }], null)).toBe(false);
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
