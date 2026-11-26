import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  validateCustomRule,
  validateCustomRules,
  scanContentWithCustomRule,
  scanFileWithCustomRules,
  loadCustomRulesFromConfig,
  matchesRuleGlobs,
  sanitizeContentForRegex,
  type CompiledCustomRule,
} from "./custom-rules.js";
import {
  scanFile,
  shouldFailScan,
  countFindingsBySeverity,
  formatScanResults,
} from "./scanner.js";
import { formatSarifJson } from "./sarif.js";
import { CsvExporter, MarkdownExporter, HtmlExporter } from "./exporters.js";

describe("Custom Rules Validation", () => {
  it("validates and compiles a complete, valid custom rule", () => {
    const raw = {
      id: "internal-token",
      pattern: "SEC_AUTH_[A-Za-z0-9]{20,}",
      globs: ["src/**/*.ts", "lib/**/*.js"],
      severity: "CRITICAL",
      message: "Internal authentication token format detected",
    };

    const res = validateCustomRule(raw);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.rule).toBeDefined();
    expect(res.rule?.id).toBe("internal-token");
    expect(res.rule?.pattern).toBe("SEC_AUTH_[A-Za-z0-9]{20,}");
    expect(res.rule?.severity).toBe("CRITICAL");
    expect(res.rule?.message).toBe("Internal authentication token format detected");
    expect(res.rule?.globs).toEqual(["src/**/*.ts", "lib/**/*.js"]);
    expect(res.rule?.compiledGlobs).toHaveLength(2);
  });

  it("normalizes case for severity (e.g. 'critical' -> 'CRITICAL')", () => {
    const raw = {
      id: "banned-eval",
      pattern: "\\beval\\s*\\(",
      severity: "high",
      message: "Direct eval() is strictly prohibited",
    };

    const res = validateCustomRule(raw);
    expect(res.valid).toBe(true);
    expect(res.rule?.severity).toBe("HIGH");
  });

  it("accepts alias fields: regex for pattern, description for message, fileGlobs/paths for globs", () => {
    const raw = {
      id: "alias-rule",
      regex: "TODO_SECURE",
      fileGlobs: "*.ts",
      severity: "LOW",
      description: "Security TODO found",
    };

    const res = validateCustomRule(raw);
    expect(res.valid).toBe(true);
    expect(res.rule?.pattern).toBe("TODO_SECURE");
    expect(res.rule?.message).toBe("Security TODO found");
    expect(res.rule?.globs).toEqual(["*.ts"]);
  });

  it("fails validation when 'id' is missing or empty", () => {
    const res = validateCustomRule({
      pattern: "test",
      severity: "HIGH",
      message: "some message",
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("missing required 'id' field");
  });

  it("fails validation when 'pattern' is missing or empty", () => {
    const res = validateCustomRule({
      id: "no-pattern",
      severity: "HIGH",
      message: "some message",
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("missing required 'pattern' field");
  });

  it("fails validation when regex syntax is invalid (e.g. unclosed bracket)", () => {
    const res = validateCustomRule({
      id: "broken-regex",
      pattern: "[a-z",
      severity: "HIGH",
      message: "unclosed class",
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("invalid regex pattern '[a-z'");
  });

  it("fails validation when severity is invalid", () => {
    const res = validateCustomRule({
      id: "invalid-sev",
      pattern: "test",
      severity: "SUPER_URGENT",
      message: "some message",
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("invalid severity 'SUPER_URGENT'");
  });

  it("fails validation when 'message' is missing or empty", () => {
    const res = validateCustomRule({
      id: "no-msg",
      pattern: "test",
      severity: "MEDIUM",
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("missing required 'message' field");
  });

  it("fails validation when file globs contain unclosed brackets", () => {
    const res = validateCustomRule({
      id: "bad-glob",
      pattern: "test",
      globs: ["tests/[a-"],
      severity: "LOW",
      message: "test message",
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("invalid file glob pattern 'tests/[a-'");
  });

  it("rejects non-array rules collection", () => {
    const res = validateCustomRules({ rule1: {} });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("'rules' must be an array of rule objects");
  });

  it("detects and rejects duplicate rule IDs", () => {
    const rawRules = [
      { id: "rule-1", pattern: "a", severity: "LOW", message: "m1" },
      { id: "rule-1", pattern: "b", severity: "HIGH", message: "m2" },
    ];
    const res = validateCustomRules(rawRules);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("Duplicate custom rule id 'rule-1'");
  });
});

describe("Custom Rules Scanning & Severity Reporting", () => {
  const tokenRule: CompiledCustomRule = {
    id: "internal-token",
    pattern: "SEC_TOKEN_[A-Za-z0-9]{16,}",
    flags: "gm",
    globs: ["src/**/*.ts"],
    compiledGlobs: undefined, // will be set below
    severity: "CRITICAL",
    message: "Leaked internal authentication token",
    timeoutMs: 100,
  };
  const evalRule: CompiledCustomRule = {
    id: "banned-eval",
    pattern: "\\beval\\s*\\(",
    flags: "gm",
    globs: undefined, // all files
    compiledGlobs: undefined,
    severity: "HIGH",
    message: "Use of banned eval() function",
    timeoutMs: 100,
  };

  it("produces findings with the configured severity and labels", () => {
    const content = `
const key = "public";
const token = "SEC_TOKEN_abcdef0123456789";
console.log("ready");
`;
    const res = scanContentWithCustomRule("src/auth.ts", content, tokenRule);
    expect(res.timedOut).toBe(false);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toEqual({
      line: 3,
      text: 'const token = "SEC_TOKEN_abcdef0123456789";',
      reason: "Leaked internal authentication token",
      severity: "CRITICAL",
      ruleId: "internal-token",
      custom: true,
    });
  });

  it("respects globs and skips files that do not match the rule's glob patterns", () => {
    const ruleWithGlobs = validateCustomRule({
      id: "ts-only",
      pattern: "FORBIDDEN",
      globs: ["**/*.ts"],
      severity: "HIGH",
      message: "Forbidden in TS",
    }).rule!;

    expect(matchesRuleGlobs("src/file.ts", ruleWithGlobs)).toBe(true);
    expect(matchesRuleGlobs("src/file.py", ruleWithGlobs)).toBe(false);

    const tsRes = scanContentWithCustomRule(
      "src/file.ts",
      "const x = FORBIDDEN;",
      ruleWithGlobs,
    );
    expect(tsRes.violations).toHaveLength(1);

    const pyRes = scanContentWithCustomRule(
      "src/file.py",
      "x = FORBIDDEN",
      ruleWithGlobs,
    );
    expect(pyRes.violations).toHaveLength(0);
  });

  it("evaluates custom rules alongside built-in scanner rules in scanFile()", () => {
    const content = `
const a = 1;
eval("2 + 2");
console.log(process.env.DB_PASSWORD);
`;
    const result = scanFile("test.js", content, [], [evalRule]);
    expect(result.violations).toHaveLength(2);

    const customFinding = result.violations.find((v) => v.custom);
    expect(customFinding).toBeDefined();
    expect(customFinding?.ruleId).toBe("banned-eval");
    expect(customFinding?.severity).toBe("HIGH");
    expect(customFinding?.reason).toBe("Use of banned eval() function");

    const builtInFinding = result.violations.find((v) => !v.custom);
    expect(builtInFinding).toBeDefined();
    expect(builtInFinding?.reason).toBe("environment variable");
  });

  it("counts findings by configured severity in countFindingsBySeverity()", () => {
    const violations = [
      { line: 1, text: "eval()", reason: "eval", severity: "HIGH" as const, custom: true },
      { line: 2, text: "token", reason: "token", severity: "CRITICAL" as const, custom: true },
      { line: 3, text: "note", reason: "note", severity: "LOW" as const, custom: true },
    ];
    const counts = countFindingsBySeverity(violations, []);
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(1);
    expect(counts.low).toBe(1);
    expect(counts.medium).toBe(0);
  });

  it("evaluates shouldFailScan() against the configured severity of custom rules", () => {
    const lowViolation = [
      { line: 1, text: "low issue", reason: "low", severity: "LOW" as const, custom: true },
    ];
    const criticalViolation = [
      { line: 1, text: "crit issue", reason: "crit", severity: "CRITICAL" as const, custom: true },
    ];

    // LOW finding should pass when failing on HIGH
    expect(shouldFailScan(lowViolation, [], "HIGH")).toBe(false);
    // LOW finding should fail when failing on LOW
    expect(shouldFailScan(lowViolation, [], "LOW")).toBe(true);

    // CRITICAL finding should fail when failing on CRITICAL or HIGH
    expect(shouldFailScan(criticalViolation, [], "CRITICAL")).toBe(true);
    expect(shouldFailScan(criticalViolation, [], "HIGH")).toBe(true);
    // In NONE advisory mode, it should not fail
    expect(shouldFailScan(criticalViolation, [], "NONE")).toBe(false);
  });
});

describe("Catastrophic Regex Backtracking Guard (ReDoS Protection)", () => {
  it("aborts a slow/catastrophic regex pattern within timeout instead of hanging the scan", () => {
    const redosRule: CompiledCustomRule = {
      id: "redos-backtracker",
      pattern: "(a+)+b",
      flags: "gm",
      severity: "HIGH",
      message: "Catastrophic regex rule",
      timeoutMs: 80, // strict 80ms timeout
    };

    // Evil payload that causes exponential backtracking in vulnerable engines
    const evilContent = "a".repeat(32) + "c";

    const t0 = performance.now();
    const res = scanContentWithCustomRule("bad.js", evilContent, redosRule, { quiet: true });
    const elapsed = performance.now() - t0;

    // Must abort cleanly without throwing
    expect(res.timedOut).toBe(true);
    expect(res.aborted).toBe(true);
    expect(res.violations).toHaveLength(0);
    // Completed in approximately the timeout window (< 500ms), NOT hanging indefinitely
    expect(elapsed).toBeLessThan(1000);
  });

  it("sanitizes excessively long lines to prevent memory exhaustion", () => {
    const hugeLine = "x".repeat(30_000);
    const sanitized = sanitizeContentForRegex(hugeLine);
    expect(sanitized.length).toBeLessThanOrEqual(20_000);
  });
});

describe("Labeling Findings in All Exporters", () => {
  const customViolations = [
    {
      line: 4,
      text: 'const t = "SEC_TOKEN_1234567890abcdef";',
      reason: "Internal token format exposed",
      severity: "CRITICAL" as const,
      ruleId: "internal-token",
      custom: true,
    },
  ];

  const results = [
    {
      path: "src/auth/token.ts",
      violations: customViolations,
    },
  ];

  it("labels custom rules clearly in standard text output", () => {
    const text = formatScanResults(results, "text");
    expect(text).toContain("[SecureFlow] [Custom Rule: internal-token]");
    expect(text).toContain("Internal token format exposed");
    expect(text).toContain("src/auth/token.ts:4");
  });

  it("labels custom rules in SARIF output", () => {
    const sarifRaw = formatSarifJson(results);
    const sarif = JSON.parse(sarifRaw);
    const run = sarif.runs[0];
    expect(run.results).toHaveLength(1);
    expect(run.results[0].ruleId).toContain("CUSTOM");
    expect(run.results[0].message.text).toContain("[Custom Rule: internal-token]");
    expect(run.results[0].level).toBe("error"); // CRITICAL -> error
    expect(run.results[0].properties.custom).toBe(true);
  });

  it("labels custom rules in CSV exporter", () => {
    const csv = new CsvExporter().export(results);
    expect(csv).toContain("[Custom Rule: internal-token] Internal token format exposed");
  });

  it("labels custom rules in Markdown exporter", () => {
    const md = new MarkdownExporter().export(results);
    expect(md).toContain("[Custom Rule: internal-token] Internal token format exposed");
  });

  it("labels custom rules in HTML exporter", () => {
    const html = new HtmlExporter().export(results);
    expect(html).toContain("[Custom Rule: internal-token] Internal token format exposed");
  });
});

describe("Configuration File Loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-custom-rules-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads valid custom rules from .secureflow.json", () => {
    const configContent = `
    {
      "rules": [
        {
          "id": "my-rule",
          "pattern": "SECRET_[0-9]+",
          "severity": "CRITICAL",
          "message": "Found secret token"
        }
      ]
    }
    `;
    fs.writeFileSync(path.join(tempDir, ".secureflow.json"), configContent, "utf-8");

    const res = loadCustomRulesFromConfig({ targetDir: tempDir });
    expect(res.loaded).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0]?.id).toBe("my-rule");
    expect(res.rules[0]?.severity).toBe("CRITICAL");
  });

  it("reports clear error messages for invalid custom rules in config file", () => {
    const badConfig = `
    {
      "rules": [
        {
          "id": "broken-rule",
          "pattern": "[invalid-regex",
          "severity": "INVALID_SEV",
          "message": "Missing fields"
        }
      ]
    }
    `;
    fs.writeFileSync(path.join(tempDir, ".secureflow.json"), badConfig, "utf-8");

    const res = loadCustomRulesFromConfig({ targetDir: tempDir });
    expect(res.loaded).toBe(true);
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.errors.some((e) => e.includes("invalid regex pattern"))).toBe(true);
    expect(res.errors.some((e) => e.includes("invalid severity"))).toBe(true);
  });
});
