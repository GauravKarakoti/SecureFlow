import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  BUILT_IN_POLICIES,
  getBuiltInPolicy,
  resolvePolicyGuidance,
  validateCustomPolicyUrl,
  isValidCustomPolicyUrl,
} from "./built-in";
import { editPolicySchema } from "./versioning";
import { policyBundleItemSchema } from "./export-import";
import { renderScanReportSummary, type ScanReportFinding } from "@/lib/github/scan-report";

describe("Built-in Policies & Help Guidance (#2098)", () => {
  it("defines exactly 24 built-in security policies", () => {
    expect(BUILT_IN_POLICIES.length).toBe(24);
  });

  it("ensures every built-in policy has valid guidance text and https helpUrl", () => {
    for (const policy of BUILT_IN_POLICIES) {
      expect(policy.id).toBeTruthy();
      expect(policy.name).toBeTruthy();
      expect(policy.description).toBeTruthy();
      expect(policy.slug).toBeTruthy();

      // Guidance check
      expect(policy.guidance).toBeDefined();
      expect(typeof policy.guidance).toBe("string");
      expect(policy.guidance.trim().length).toBeGreaterThan(15);

      // Help URL check
      expect(policy.helpUrl).toBeDefined();
      expect(typeof policy.helpUrl).toBe("string");
      expect(policy.helpUrl).toMatch(/^https:\/\//);
      expect(policy.helpUrl).toContain(policy.slug);
    }
  });

  it("verifies every built-in policy has a corresponding documentation file in docs/policies/", () => {
    const docsDir = path.resolve(process.cwd(), "docs/policies");
    expect(fs.existsSync(docsDir)).toBe(true);

    for (const policy of BUILT_IN_POLICIES) {
      const docPath = path.join(docsDir, policy.slug);
      expect(
        fs.existsSync(docPath),
        `Guidance document missing for policy '${policy.name}': expected at ${docPath}`
      ).toBe(true);

      const content = fs.readFileSync(docPath, "utf-8");

      // Verify sections: Title, Problem, Example, Fix
      expect(content).toContain(`# ${policy.name}`);
      expect(content).toContain("## Problem");
      expect(content).toContain("## Example");
      expect(content).toContain("## Fix");

      // Verify non-empty sections
      const problemIndex = content.indexOf("## Problem");
      const exampleIndex = content.indexOf("## Example");
      const fixIndex = content.indexOf("## Fix");

      expect(problemIndex).toBeGreaterThan(-1);
      expect(exampleIndex).toBeGreaterThan(problemIndex);
      expect(fixIndex).toBeGreaterThan(exampleIndex);

      const problemText = content.substring(problemIndex + 10, exampleIndex).trim();
      const exampleText = content.substring(exampleIndex + 10, fixIndex).trim();
      const fixText = content.substring(fixIndex + 6).trim();

      expect(problemText.length).toBeGreaterThan(30);
      expect(exampleText.length).toBeGreaterThan(20);
      expect(fixText.length).toBeGreaterThan(20);
    }
  });

  it("retrieves built-in policies by name, id, and condition key", () => {
    const byName = getBuiltInPolicy("Enforce Parameterized Queries");
    expect(byName).toBeDefined();
    expect(byName?.id).toBe("enforce-parameterized-queries");

    const byId = getBuiltInPolicy("prevent-pii-logging");
    expect(byId).toBeDefined();
    expect(byId?.name).toBe("Prevent PII Logging");

    const byCondition = getBuiltInPolicy("db/raw_query/*");
    expect(byCondition).toBeDefined();
    expect(byCondition?.id).toBe("enforce-parameterized-queries");

    const unknown = getBuiltInPolicy("non_existent_policy_xyz");
    expect(unknown).toBeUndefined();
  });

  it("resolves policy guidance dynamically from finding metadata", () => {
    // Exact policy name match
    const fromName = resolvePolicyGuidance({
      policyName: "Enforce Parameterized Queries",
    });
    expect(fromName.helpUrl).toContain("enforce-parameterized-queries.md");
    expect(fromName.guidance).toContain("parameterized queries");

    // Finding type keyword match
    const fromType = resolvePolicyGuidance({
      type: "SQL_INJECTION",
    });
    expect(fromType.helpUrl).toContain("enforce-parameterized-queries.md");
    expect(fromType.guidance).toBeDefined();

    // Custom finding override takes precedence
    const custom = resolvePolicyGuidance({
      type: "SQL_INJECTION",
      helpUrl: "https://my-internal-wiki.com/sql-policy",
      guidance: "Use our custom DB wrapper",
    });
    expect(custom.helpUrl).toBe("https://my-internal-wiki.com/sql-policy");
    expect(custom.guidance).toBe("Use our custom DB wrapper");
  });
});

describe("Custom Policy Help URL Validation (#2098)", () => {
  it("validates that custom policy URLs must use https", () => {
    // Valid HTTPS URLs
    expect(isValidCustomPolicyUrl("https://docs.company.internal/security/policy-1")).toBe(true);
    expect(isValidCustomPolicyUrl("https://github.com/org/repo/blob/main/docs/rule.md")).toBe(true);
    expect(validateCustomPolicyUrl("https://example.com/guide").valid).toBe(true);

    // Empty or omitted is valid (optional)
    expect(isValidCustomPolicyUrl("")).toBe(true);
    expect(validateCustomPolicyUrl("").valid).toBe(true);
    expect(validateCustomPolicyUrl(undefined).valid).toBe(true);
    expect(validateCustomPolicyUrl(null).valid).toBe(true);

    // Insecure HTTP is rejected
    expect(isValidCustomPolicyUrl("http://insecure-site.com/policy")).toBe(false);
    const httpResult = validateCustomPolicyUrl("http://insecure-site.com/policy");
    expect(httpResult.valid).toBe(false);
    expect(httpResult.error).toContain("https://");

    // Other protocols rejected
    expect(isValidCustomPolicyUrl("ftp://ftp.example.com/file")).toBe(false);
    expect(isValidCustomPolicyUrl("javascript:alert(1)")).toBe(false);
    expect(validateCustomPolicyUrl("ftp://ftp.example.com").valid).toBe(false);

    // Malformed URLs rejected
    expect(isValidCustomPolicyUrl("not-a-url")).toBe(false);
    expect(validateCustomPolicyUrl("not-a-url").valid).toBe(false);
  });

  it("enforces https validation in editPolicySchema Zod schema", () => {
    const valid = editPolicySchema.safeParse({
      templateId: "tpl-123",
      description: "Updated description",
      severity: "HIGH",
      helpUrl: "https://secure-docs.example.com/rule",
      guidance: "Follow our secure coding guide",
    });
    expect(valid.success).toBe(true);

    const invalid = editPolicySchema.safeParse({
      templateId: "tpl-123",
      description: "Updated description",
      severity: "HIGH",
      helpUrl: "http://insecure-docs.example.com/rule",
    });
    expect(invalid.success).toBe(false);
  });

  it("enforces https validation in policyBundleItemSchema Zod schema", () => {
    const valid = policyBundleItemSchema.safeParse({
      name: "Custom Rule",
      description: "Custom rule description",
      severity: "HIGH",
      enabled: true,
      helpUrl: "https://internal-docs.corp/sec-policy",
      guidance: "Check out the wiki",
    });
    expect(valid.success).toBe(true);

    const invalid = policyBundleItemSchema.safeParse({
      name: "Custom Rule",
      description: "Custom rule description",
      severity: "HIGH",
      enabled: true,
      helpUrl: "http://plain-http.corp/sec-policy",
    });
    expect(invalid.success).toBe(false);
  });
});

describe("PR Comment 'How to fix' Rendering (#2098)", () => {
  it("renders 'How to fix' link and guidance in pull request summary comment", () => {
    const findings: ScanReportFinding[] = [
      {
        id: "find-1",
        type: "SQL_INJECTION",
        severity: "HIGH",
        fileLocation: "src/server/db.ts",
        explanation: "Raw query concatenation detected.",
      },
    ];

    const report = renderScanReportSummary({
      findings,
      totalFindings: 1,
    });

    // Check for 'How to fix' link and guidance
    expect(report).toContain("[How to fix]");
    expect(report).toContain("enforce-parameterized-queries.md");
    expect(report).toContain("parameterized queries");
  });

  it("renders custom policy helpUrl and guidance when provided on finding", () => {
    const findings: ScanReportFinding[] = [
      {
        id: "find-custom",
        type: "CUSTOM_INTERNAL_CHECK",
        severity: "CRITICAL",
        fileLocation: "src/api/auth.ts",
        explanation: "Custom internal token check failed.",
        helpUrl: "https://security.company.com/how-to-fix-auth",
        guidance: "Use the internal AuthTokenValidator class.",
      },
    ];

    const report = renderScanReportSummary({
      findings,
      totalFindings: 1,
    });

    expect(report).toContain("[How to fix](https://security.company.com/how-to-fix-auth)");
    expect(report).toContain("Use the internal AuthTokenValidator class.");
  });
});
