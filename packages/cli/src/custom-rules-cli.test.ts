import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanFile,
  shouldFailScan,
  countFindingsBySeverity,
  formatScanResults,
  type FileScanResult,
} from "./scanner.js";
import {
  loadCustomRulesFromConfig,
  scanFileWithCustomRules,
  validateCustomRules,
} from "./custom-rules.js";

describe("Custom Rules CLI & Scanner Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-custom-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("produces findings with configured severity from .secureflow.json", () => {
    const config = {
      rules: [
        {
          id: "corp-token",
          pattern: "CORP_SECRET_[A-Za-z0-9]{10,}",
          globs: ["**/*.ts"],
          severity: "CRITICAL",
          message: "Corporate secret token exposed in source code",
        },
        {
          id: "banned-eval",
          pattern: "\\beval\\s*\\(",
          globs: ["**/*.js"],
          severity: "HIGH",
          message: "Dangerous eval() function invocation",
        },
      ],
    };

    const configPath = path.join(tempDir, ".secureflow.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const loaded = loadCustomRulesFromConfig({ configPath });
    expect(loaded.loaded).toBe(true);
    expect(loaded.errors).toHaveLength(0);
    expect(loaded.rules).toHaveLength(2);

    // Test TS file matching corp-token
    const tsCode = 'const secret = "CORP_SECRET_abcdef123456";';
    const tsRes = scanFile("src/auth.ts", tsCode, [], loaded.rules);
    expect(tsRes.violations).toHaveLength(1);
    expect(tsRes.violations[0]?.severity).toBe("CRITICAL");
    expect(tsRes.violations[0]?.ruleId).toBe("corp-token");
    expect(tsRes.violations[0]?.custom).toBe(true);

    // Test JS file matching banned-eval
    const jsCode = 'const res = eval("1 + 1");';
    const jsRes = scanFile("src/calc.js", jsCode, [], loaded.rules);
    expect(jsRes.violations).toHaveLength(1);
    expect(jsRes.violations[0]?.severity).toBe("HIGH");
    expect(jsRes.violations[0]?.ruleId).toBe("banned-eval");

    // Severity counts
    const allViolations = [...tsRes.violations, ...jsRes.violations];
    const counts = countFindingsBySeverity(allViolations, []);
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(1);
    expect(counts.medium).toBe(0);
    expect(counts.low).toBe(0);

    // Gate threshold evaluation
    expect(shouldFailScan(allViolations, [], "CRITICAL")).toBe(true);
    expect(shouldFailScan(allViolations, [], "HIGH")).toBe(true);
    expect(shouldFailScan(allViolations, [], "NONE")).toBe(false);

    // Formatted text output labels
    const textOut = formatScanResults([tsRes, jsRes], "text");
    expect(textOut).toContain("[SecureFlow] [Custom Rule: corp-token]");
    expect(textOut).toContain("Corporate secret token exposed in source code");
    expect(textOut).toContain("[SecureFlow] [Custom Rule: banned-eval]");
    expect(textOut).toContain("Dangerous eval() function invocation");
  });

  it("stops and reports helpful errors when rules in config are invalid", () => {
    const invalidConfig = {
      rules: [
        {
          id: "bad-rule",
          pattern: "(unclosed-group",
          severity: "NOT_A_REAL_SEVERITY",
          message: "",
        },
      ],
    };

    const configPath = path.join(tempDir, ".secureflow.json");
    fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2), "utf-8");

    const loaded = loadCustomRulesFromConfig({ configPath });
    expect(loaded.loaded).toBe(true);
    expect(loaded.errors.length).toBeGreaterThanOrEqual(3);

    const regexErr = loaded.errors.find((e) => e.includes("invalid regex pattern"));
    const sevErr = loaded.errors.find((e) => e.includes("invalid severity"));
    const msgErr = loaded.errors.find((e) => e.includes("missing required 'message'"));

    expect(regexErr).toBeDefined();
    expect(sevErr).toBeDefined();
    expect(msgErr).toBeDefined();
  });

  it("aborts a slow/catastrophic regex pattern instead of hanging the scan", () => {
    const slowRuleConfig = {
      rules: [
        {
          id: "catastrophic-redos",
          pattern: "(x+x+)+y",
          severity: "HIGH",
          message: "Catastrophic regex pattern",
          timeoutMs: 50,
        },
      ],
    };

    const configPath = path.join(tempDir, ".secureflow.json");
    fs.writeFileSync(configPath, JSON.stringify(slowRuleConfig, null, 2), "utf-8");

    const loaded = loadCustomRulesFromConfig({ configPath });
    expect(loaded.rules).toHaveLength(1);

    const evilPayload = "x".repeat(30) + "z";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tStart = performance.now();
    const scanResult = scanFile("test.ts", evilPayload, [], loaded.rules);
    const duration = performance.now() - tStart;

    // Scan was not hung; aborted within small timeout window
    expect(duration).toBeLessThan(1000);
    // Violations should be empty because pattern timed out
    expect(scanResult.violations).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("supports loading custom configuration file via explicit path", () => {
    const customConfig = {
      rules: [
        {
          id: "custom-path-rule",
          pattern: "CUSTOM_TOKEN",
          severity: "MEDIUM",
          message: "Found custom token",
        },
      ],
    };

    const customPath = path.join(tempDir, "my-secureflow.json");
    fs.writeFileSync(customPath, JSON.stringify(customConfig), "utf-8");

    const loaded = loadCustomRulesFromConfig({ configPath: customPath });
    expect(loaded.loaded).toBe(true);
    expect(loaded.errors).toHaveLength(0);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]?.id).toBe("custom-path-rule");
    expect(loaded.rules[0]?.severity).toBe("MEDIUM");
  });
});
