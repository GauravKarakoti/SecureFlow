import { describe, it, expect } from "vitest";
import {
  validatePolicyImportPayload,
  computeImportPreview,
  policyExportFileSchema,
  policyBundleItemSchema,
  type PolicyBundleItem,
} from "./export-import";

describe("Policy Export/Import Schema Validation", () => {
  const validPolicy: PolicyBundleItem = {
    name: "Enforce Parameterized Queries",
    description:
      "Requires manual review for raw SQL queries to prevent SQL Injection vulnerabilities.",
    severity: "HIGH",
    enabled: true,
    action: "REVIEW REQUIRED",
    rules: ["db/raw_query/*"],
    complianceTags: ["SOC 2", "OWASP Top 10"],
  };

  it("accepts a valid version 1.0 policy file", () => {
    const payload = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      policies: [validPolicy],
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(true);
    expect(res.data?.policies).toHaveLength(1);
    expect(res.data?.policies[0].name).toBe(validPolicy.name);
  });

  it("rejects file with unsupported version", () => {
    const payload = {
      version: "2.0",
      policies: [validPolicy],
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid literal value, expected "1.0"');
  });

  it("rejects unknown extra fields at the root (strict mode)", () => {
    const payload = {
      version: "1.0",
      policies: [validPolicy],
      maliciousField: "rm -rf /",
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Unrecognized key");
  });

  it("rejects unknown extra fields inside a policy item", () => {
    const payload = {
      version: "1.0",
      policies: [
        {
          ...validPolicy,
          executableCode: "eval('malicious')",
        },
      ],
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Unrecognized key");
  });

  it("rejects invalid severity values", () => {
    const payload = {
      version: "1.0",
      policies: [
        {
          ...validPolicy,
          severity: "SUPER_CRITICAL",
        },
      ],
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid enum value");
  });

  it("rejects empty policies array", () => {
    const payload = {
      version: "1.0",
      policies: [],
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Policy file contains no policies");
  });

  it("rejects empty policy name or description", () => {
    const payload = {
      version: "1.0",
      policies: [
        {
          ...validPolicy,
          name: "   ",
        },
      ],
    };

    const res = validatePolicyImportPayload(payload);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Policy name cannot be empty");
  });
});

describe("computeImportPreview", () => {
  const existingTemplates = [
    {
      id: "tpl-1",
      name: "Enforce Parameterized Queries",
      description: "Old description",
      severity: "HIGH",
      action: "REVIEW REQUIRED",
      isDefault: true,
    },
    {
      id: "tpl-2",
      name: "Prevent Hardcoded Tokens",
      description: "Blocks hardcoded tokens",
      severity: "CRITICAL",
      action: "DENY",
      isDefault: false,
    },
  ];

  const userToggles = [
    { policyTemplateId: "tpl-1", isActive: true },
    { policyTemplateId: "tpl-2", isActive: false },
  ];

  it("correctly identifies policies to create, update, and unchanged", () => {
    const incoming: PolicyBundleItem[] = [
      // 1. Update: description changed
      {
        name: "Enforce Parameterized Queries",
        description: "New updated description",
        severity: "HIGH",
        enabled: true,
        action: "REVIEW REQUIRED",
        rules: [],
        complianceTags: [],
      },
      // 2. Unchanged: matches existing tpl-2 perfectly (tpl-2 is isActive: false)
      {
        name: "Prevent Hardcoded Tokens",
        description: "Blocks hardcoded tokens",
        severity: "CRITICAL",
        enabled: false,
        action: "DENY",
        rules: [],
        complianceTags: [],
      },
      // 3. Create: completely new policy
      {
        name: "Disallow Plaintext HTTP",
        description: "Enforce HTTPS everywhere",
        severity: "MEDIUM",
        enabled: true,
        action: "REVIEW REQUIRED",
        rules: [],
        complianceTags: [],
      },
    ];

    const preview = computeImportPreview(incoming, existingTemplates, userToggles);

    expect(preview.totalInFile).toBe(3);
    expect(preview.toCreate).toBe(1);
    expect(preview.toUpdate).toBe(1);
    expect(preview.unchanged).toBe(1);

    expect(preview.items[0]).toMatchObject({
      name: "Enforce Parameterized Queries",
      status: "update",
      diff: { descriptionChanged: true, severityChanged: false, enabledChanged: false },
    });

    expect(preview.items[1]).toMatchObject({
      name: "Prevent Hardcoded Tokens",
      status: "unchanged",
    });

    expect(preview.items[2]).toMatchObject({
      name: "Disallow Plaintext HTTP",
      status: "create",
    });
  });

  it("handles case-insensitivity on policy name matching", () => {
    const incoming: PolicyBundleItem[] = [
      {
        name: "enforce parameterized queries",
        description: "Old description",
        severity: "HIGH",
        enabled: true,
        action: "REVIEW REQUIRED",
        rules: [],
        complianceTags: [],
      },
    ];

    const preview = computeImportPreview(incoming, existingTemplates, userToggles);
    expect(preview.toCreate).toBe(0);
    expect(preview.unchanged).toBe(1);
  });
});
