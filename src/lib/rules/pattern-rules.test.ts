import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  scanFileWithPatternRules,
  runPatternSecurityRules,
  getLanguageFamily,
  extractAddedLines,
  PATTERN_RULE_IDS,
} from "./pattern-rules";
import { mergePrecheckWithLlmFindings } from "@/lib/armor/precheck";
import { parseSecureFlowConfig, resolvePatternRuleOptions } from "@/lib/scanner/gate-config";
import type { ScanFinding } from "@/lib/armor/scanner";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

function makePatchFromContent(content: string): string {
  const lines = content.split(/\r?\n/);
  return (
    `--- a/file\n+++ b/file\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join("\n")
  );
}

describe("Deterministic Pattern Security Rules (#2088)", () => {
  describe("Language Family Detection", () => {
    it("detects Python files", () => {
      expect(getLanguageFamily("app/main.py")).toBe("python");
      expect(getLanguageFamily("settings.pyw")).toBe("python");
    });

    it("detects JavaScript and TypeScript files", () => {
      expect(getLanguageFamily("src/index.ts")).toBe("typescript");
      expect(getLanguageFamily("src/component.tsx")).toBe("typescript");
      expect(getLanguageFamily("server.js")).toBe("javascript");
      expect(getLanguageFamily("client.jsx")).toBe("javascript");
    });

    it("detects shell scripts", () => {
      expect(getLanguageFamily("scripts/deploy.sh")).toBe("shell");
      expect(getLanguageFamily("install.bash")).toBe("shell");
      expect(getLanguageFamily("setup.zsh")).toBe("shell");
    });

    it("defaults to generic for unknown extensions", () => {
      expect(getLanguageFamily("Dockerfile")).toBe("generic");
      expect(getLanguageFamily("config.yaml")).toBe("generic");
    });
  });

  describe("Matching Only Runs On Added Lines", () => {
    it("flags added lines but ignores context or removed lines", () => {
      const patchWithRemoved = [
        "--- a/deploy.sh",
        "+++ b/deploy.sh",
        "@@ -1,3 +1,3 @@",
        "-chmod 777 /tmp/app.sh",
        " echo 'keeping context'",
        "+chmod 755 /tmp/app.sh",
      ].join("\n");

      const findings = scanFileWithPatternRules({
        filename: "deploy.sh",
        patch: patchWithRemoved,
      });

      expect(findings).toHaveLength(0);
    });

    it("flags vulnerable pattern when present on added line (+)", () => {
      const patchWithAdded = [
        "--- a/deploy.sh",
        "+++ b/deploy.sh",
        "@@ -1,2 +1,3 @@",
        " echo 'start'",
        "+chmod 777 /tmp/app.sh",
        " echo 'end'",
      ].join("\n");

      const findings = scanFileWithPatternRules({
        filename: "deploy.sh",
        patch: patchWithAdded,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.SHELL_CHMOD_777);
    });
  });

  describe("Fixture Tests: Vulnerable vs Safe", () => {
    it("Rule 1: Python verify=False vs Safe", () => {
      const vulnContent = readFixture("pattern-tls-verify.vulnerable.py");
      const safeContent = readFixture("pattern-tls-verify.safe.py");

      const vulnFindings = scanFileWithPatternRules({
        filename: "client.py",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "client.py",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(
        PATTERN_RULE_IDS.PYTHON_TLS_VERIFY_DISABLED,
      );
      expect(vulnFindings[0].severity).toBe("CRITICAL");
      expect(vulnFindings[0].remediation).toContain("verify");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 2: Python yaml.load vs yaml.safe_load", () => {
      const vulnContent = readFixture("pattern-yaml-load.vulnerable.py");
      const safeContent = readFixture("pattern-yaml-load.safe.py");

      const vulnFindings = scanFileWithPatternRules({
        filename: "config.py",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "config.py",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.PYTHON_UNSAFE_YAML_LOAD);
      expect(vulnFindings[0].severity).toBe("HIGH");
      expect(vulnFindings[0].remediation).toContain("yaml.safe_load");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 3: Python pickle.loads vs json.loads", () => {
      const vulnContent = readFixture("pattern-pickle.vulnerable.py");
      const safeContent = readFixture("pattern-pickle.safe.py");

      const vulnFindings = scanFileWithPatternRules({
        filename: "session.py",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "session.py",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.PYTHON_UNSAFE_PICKLE);
      expect(vulnFindings[0].severity).toBe("CRITICAL");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 4: Python DEBUG = True in settings vs DEBUG = False", () => {
      const vulnContent = readFixture("pattern-debug.vulnerable.py");
      const safeContent = readFixture("pattern-debug.safe.py");

      const vulnFindings = scanFileWithPatternRules({
        filename: "settings.py",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "settings.py",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.PYTHON_DEBUG_ENABLED);
      expect(vulnFindings[0].severity).toBe("HIGH");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 5: Node.js rejectUnauthorized: false vs rejectUnauthorized: true", () => {
      const vulnContent = readFixture("pattern-node-tls.vulnerable.ts");
      const safeContent = readFixture("pattern-node-tls.safe.ts");

      const vulnFindings = scanFileWithPatternRules({
        filename: "api.ts",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "api.ts",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(
        PATTERN_RULE_IDS.JS_TLS_REJECT_UNAUTHORIZED,
      );
      expect(vulnFindings[0].severity).toBe("CRITICAL");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 6: JavaScript eval() vs JSON.parse()", () => {
      const vulnContent = readFixture("pattern-eval.vulnerable.js");
      const safeContent = readFixture("pattern-eval.safe.js");

      const vulnFindings = scanFileWithPatternRules({
        filename: "calc.js",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "calc.js",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.JS_EVAL_USAGE);
      expect(vulnFindings[0].severity).toBe("HIGH");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 7: JavaScript innerHTML vs textContent", () => {
      const vulnContent = readFixture("pattern-innerhtml.vulnerable.ts");
      const safeContent = readFixture("pattern-innerhtml.safe.ts");

      const vulnFindings = scanFileWithPatternRules({
        filename: "render.ts",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "render.ts",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.JS_DANGEROUS_INNER_HTML);
      expect(vulnFindings[0].severity).toBe("HIGH");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 8: Shell chmod 777 vs chmod 755", () => {
      const vulnContent = readFixture("pattern-chmod.vulnerable.sh");
      const safeContent = readFixture("pattern-chmod.safe.sh");

      const vulnFindings = scanFileWithPatternRules({
        filename: "deploy.sh",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "deploy.sh",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.SHELL_CHMOD_777);
      expect(vulnFindings[0].severity).toBe("HIGH");
      expect(safeFindings).toHaveLength(0);
    });

    it("Rule 9: Shell curl | sh vs verified script execution", () => {
      const vulnContent = readFixture("pattern-curl-pipe-sh.vulnerable.sh");
      const safeContent = readFixture("pattern-curl-pipe-sh.safe.sh");

      const vulnFindings = scanFileWithPatternRules({
        filename: "bootstrap.sh",
        patch: makePatchFromContent(vulnContent),
      });
      const safeFindings = scanFileWithPatternRules({
        filename: "bootstrap.sh",
        patch: makePatchFromContent(safeContent),
      });

      expect(vulnFindings.length).toBeGreaterThanOrEqual(1);
      expect(vulnFindings[0].matchedSignatures).toContain(PATTERN_RULE_IDS.SHELL_CURL_PIPE_SH);
      expect(vulnFindings[0].severity).toBe("CRITICAL");
      expect(safeFindings).toHaveLength(0);
    });
  });

  describe("Disabling Rules in .secureflow.json", () => {
    it("disables specific pattern rules via disabledRules array in config", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          disabledRules: [PATTERN_RULE_IDS.SHELL_CHMOD_777],
        }),
      );

      const options = resolvePatternRuleOptions(config);
      expect(options.disabledRules).toContain(PATTERN_RULE_IDS.SHELL_CHMOD_777);

      const vulnContent = readFixture("pattern-chmod.vulnerable.sh");
      const findings = scanFileWithPatternRules(
        {
          filename: "deploy.sh",
          patch: makePatchFromContent(vulnContent),
        },
        options,
      );

      expect(findings).toHaveLength(0);
    });

    it("disables rules via rules object (ruleName: false)", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          rules: {
            [PATTERN_RULE_IDS.PYTHON_TLS_VERIFY_DISABLED]: false,
          },
        }),
      );

      const options = resolvePatternRuleOptions(config);
      expect(options.disabledRules).toContain(PATTERN_RULE_IDS.PYTHON_TLS_VERIFY_DISABLED);

      const vulnContent = readFixture("pattern-tls-verify.vulnerable.py");
      const findings = scanFileWithPatternRules(
        {
          filename: "client.py",
          patch: makePatchFromContent(vulnContent),
        },
        options,
      );

      expect(findings).toHaveLength(0);
    });

    it("disables all pattern rules via patterns: false", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          patterns: false,
        }),
      );

      const options = resolvePatternRuleOptions(config);
      expect(options.enabled).toBe(false);

      const vulnContent = readFixture("pattern-chmod.vulnerable.sh");
      const findings = scanFileWithPatternRules(
        {
          filename: "deploy.sh",
          patch: makePatchFromContent(vulnContent),
        },
        options,
      );

      expect(findings).toHaveLength(0);
    });

    it("disables specific pattern rules via patterns.disabled array", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          patterns: {
            disabled: [PATTERN_RULE_IDS.SHELL_CURL_PIPE_SH],
          },
        }),
      );

      const options = resolvePatternRuleOptions(config);
      expect(options.disabledRules).toContain(PATTERN_RULE_IDS.SHELL_CURL_PIPE_SH);

      const vulnContent = readFixture("pattern-curl-pipe-sh.vulnerable.sh");
      const findings = scanFileWithPatternRules(
        {
          filename: "bootstrap.sh",
          patch: makePatchFromContent(vulnContent),
        },
        options,
      );

      expect(findings).toHaveLength(0);
    });
  });

  describe("Fingerprint Deduplication with LLM Findings", () => {
    it("merges deterministic pattern finding with LLM finding by fingerprint", () => {
      const vulnContent = readFixture("pattern-tls-verify.vulnerable.py");
      const patternFindings = scanFileWithPatternRules({
        filename: "client.py",
        patch: makePatchFromContent(vulnContent),
      });

      expect(patternFindings).toHaveLength(1);
      const patFinding = patternFindings[0];

      // Simulated LLM finding on the same line or matching dynamic fingerprint
      const llmFinding: ScanFinding = {
        type: "Insecure Transport",
        severity: "CRITICAL",
        description: "LLM detected TLS verification disabled",
        fileLocation: "client.py",
        lineStart: patFinding.lineStart,
        lineEnd: patFinding.lineEnd,
        codeSnippet: patFinding.codeSnippet,
        dynamicFingerprint: patFinding.dynamicFingerprint,
        fingerprint: patFinding.fingerprint,
      };

      const merged = mergePrecheckWithLlmFindings(patternFindings, [llmFinding]);

      // Exactly 1 finding should be kept, with the deterministic finding retained
      expect(merged).toHaveLength(1);
      expect(merged[0].matchedSignatures).toContain(PATTERN_RULE_IDS.PYTHON_TLS_VERIFY_DISABLED);
      expect(merged[0].confidenceReason).toContain("Deterministic pattern match");
    });
  });
});
