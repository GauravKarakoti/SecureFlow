import { describe, it, expect } from "vitest";
import {
  validateSecureFlowJson,
  validateSecureFlowIgnore,
  stripJsonComments,
  isValidGlob,
  isValidExpiryDate,
} from "./config-schema.js";

describe("stripJsonComments", () => {
  it("removes single-line // comments while preserving line count", () => {
    const raw = `{\n  // comment line\n  "key": "value"\n}`;
    const stripped = stripJsonComments(raw);
    expect(stripped).not.toContain("//");
    expect(stripped.split("\n").length).toBe(raw.split("\n").length);
    expect(JSON.parse(stripped)).toEqual({ key: "value" });
  });

  it("removes multi-line /* */ comments while preserving line count", () => {
    const raw = `{\n  /* multi\n     line\n     comment */\n  "key": "value"\n}`;
    const stripped = stripJsonComments(raw);
    expect(stripped).not.toContain("/*");
    expect(stripped.split("\n").length).toBe(raw.split("\n").length);
    expect(JSON.parse(stripped)).toEqual({ key: "value" });
  });

  it("leaves strings containing // or /* intact", () => {
    const raw = `{"url": "https://secureflow.dev/test"}`;
    const stripped = stripJsonComments(raw);
    expect(JSON.parse(stripped)).toEqual({ url: "https://secureflow.dev/test" });
  });
});

describe("isValidGlob", () => {
  it("validates valid glob patterns", () => {
    expect(isValidGlob("src/**")).toBe(true);
    expect(isValidGlob("*.ts")).toBe(true);
    expect(isValidGlob("terraform/*.tf")).toBe(true);
    expect(isValidGlob("tests/**/fixtures/*")).toBe(true);
    expect(isValidGlob("node_modules/**")).toBe(true);
  });

  it("rejects invalid, unclosed, or empty globs", () => {
    expect(isValidGlob("")).toBe(false);
    expect(isValidGlob("   ")).toBe(false);
    expect(isValidGlob(null)).toBe(false);
    expect(isValidGlob(undefined)).toBe(false);
    expect(isValidGlob("tests/[a-")).toBe(false); // unclosed bracket
    expect(isValidGlob("src/{a,b")).toBe(false); // unclosed brace
    expect(isValidGlob("src/***")).toBe(false); // triple asterisk
    expect(isValidGlob("path/\0/evil")).toBe(false); // null byte
  });
});

describe("isValidExpiryDate", () => {
  it("validates correct calendar dates", () => {
    expect(isValidExpiryDate("2026-12-31")).toBe(true);
    expect(isValidExpiryDate("2026-06-15")).toBe(true);
  });

  it("rejects invalid or non-existent calendar dates", () => {
    expect(isValidExpiryDate("2026-02-31")).toBe(false);
    expect(isValidExpiryDate("2026-13-01")).toBe(false);
    expect(isValidExpiryDate("not-a-date")).toBe(false);
  });
});

describe("validateSecureFlowJson", () => {
  it("passes for valid .secureflow.json with comments", () => {
    const content = `
    // SecureFlow Repository Gate
    {
      "$schema": "https://secure-flow-six.vercel.app/schema.json",
      "gate": {
        // Minimum severity threshold
        "blockOn": "HIGH",
        "reviewOn": "MEDIUM",
        "overrides": [
          { "type": "SECRET", "blockOn": "CRITICAL" }
        ],
        "paths": [
          { "glob": "infra/**", "blockOn": "HIGH" }
        ]
      },
      "policyScopes": [
        {
          "paths": ["terraform/**", "*.tf"],
          "enable": ["Infrastructure Security"]
        }
      ]
    }
    `;

    const errors = validateSecureFlowJson(content);
    expect(errors).toHaveLength(0);
  });

  it("reports unknown keys at root level with line numbers", () => {
    const content = `{\n  "gate": {\n    "blockOn": "HIGH"\n  },\n  "unknownRootKey": 123\n}`;
    const errors = validateSecureFlowJson(content);
    expect(errors.length).toBeGreaterThan(0);
    const unknown = errors.find((e) => e.code === "UNKNOWN_KEY");
    expect(unknown).toBeDefined();
    expect(unknown?.line).toBe(5);
    expect(unknown?.message).toContain('Unknown key "unknownRootKey" at root level');
  });

  it("reports unknown keys in gate object with line numbers", () => {
    const content = `{\n  "gate": {\n    "blockOn": "HIGH",\n    "badGateKey": true\n  }\n}`;
    const errors = validateSecureFlowJson(content);
    const unknown = errors.find((e) => e.message.includes('Unknown key "badGateKey" in "gate"'));
    expect(unknown).toBeDefined();
    expect(unknown?.line).toBe(4);
  });

  it("reports invalid severities with line numbers", () => {
    const content = `{\n  "gate": {\n    "blockOn": "SUPER_CRITICAL"\n  }\n}`;
    const errors = validateSecureFlowJson(content);
    const sevError = errors.find((e) => e.code === "INVALID_SEVERITY");
    expect(sevError).toBeDefined();
    expect(sevError?.line).toBe(3);
    expect(sevError?.message).toContain('Invalid severity "SUPER_CRITICAL"');
  });

  it("reports invalid globs in gate.paths with line numbers", () => {
    const content = `{\n  "gate": {\n    "paths": [\n      { "glob": "infra/[a-" }\n    ]\n  }\n}`;
    const errors = validateSecureFlowJson(content);
    const globError = errors.find((e) => e.code === "INVALID_GLOB");
    expect(globError).toBeDefined();
    expect(globError?.line).toBe(4);
    expect(globError?.message).toContain('Invalid glob pattern "infra/[a-"');
  });

  it("reports invalid globs in policyScopes with line numbers", () => {
    const content = `{\n  "policyScopes": [\n    {\n      "paths": ["terraform/{a,b"]\n    }\n  ]\n}`;
    const errors = validateSecureFlowJson(content);
    const globError = errors.find((e) => e.code === "INVALID_GLOB");
    expect(globError).toBeDefined();
    expect(globError?.line).toBe(4);
    expect(globError?.message).toContain('Invalid glob pattern "terraform/{a,b"');
  });

  it("reports JSON syntax errors with line numbers", () => {
    const content = `{\n  "gate": {\n    "blockOn": "HIGH",\n`;
    const errors = validateSecureFlowJson(content);
    expect(errors.length).toBeGreaterThan(0);
    const syntaxErr = errors.find((e) => e.code === "SYNTAX_ERROR");
    expect(syntaxErr).toBeDefined();
    expect(syntaxErr?.line).toBeGreaterThanOrEqual(1);
  });
});

describe("validateSecureFlowIgnore", () => {
  it("passes for valid .secureflowignore content", () => {
    const content = `
    # Valid secureflowignore file
    [paths]
    node_modules/**: vendored dependencies
    dist/**: build output
    tests/fixtures/* [reason=test fixtures]

    [placeholders]
    sk_test_12345*: test key [expires=2026-12-31]
    `;

    const errors = validateSecureFlowIgnore(content);
    expect(errors).toHaveLength(0);
  });

  it("reports unknown section headers with line numbers", () => {
    const content = `# header\n[invalid_section]\nnode_modules/**`;
    const errors = validateSecureFlowIgnore(content);
    const sectionErr = errors.find((e) => e.code === "UNKNOWN_SECTION");
    expect(sectionErr).toBeDefined();
    expect(sectionErr?.line).toBe(2);
    expect(sectionErr?.message).toContain('Unknown section header "[invalid_section]"');
  });

  it("reports invalid globs with line numbers", () => {
    const content = `[paths]\nnode_modules/**\ninfra/[a- # broken glob`;
    const errors = validateSecureFlowIgnore(content);
    const globErr = errors.find((e) => e.code === "INVALID_GLOB");
    expect(globErr).toBeDefined();
    expect(globErr?.line).toBe(3);
    expect(globErr?.message).toContain('Invalid glob pattern "infra/[a-"');
  });

  it("reports invalid expiry dates with line numbers", () => {
    const content = `[placeholders]\nmock_key* [expires=2026-02-31]`;
    const errors = validateSecureFlowIgnore(content);
    const expiryErr = errors.find((e) => e.code === "INVALID_EXPIRY");
    expect(expiryErr).toBeDefined();
    expect(expiryErr?.line).toBe(2);
    expect(expiryErr?.message).toContain('Invalid expiry date "2026-02-31"');
  });
});
