import { describe, it, expect } from "vitest";
import {
  maskEmail,
  maskSecretValue,
  looksLikeSecret,
  hashIdentifier,
  sanitizeAuditMetadata,
  sanitizeAuditLogInput,
} from "./minimization";

// ─────────────────────────────────────────────────────────────────────────────
//  Unit tests for src/lib/audit/minimization.ts
//  Issue #404 — Implement Data Minimization for Audit Logs
// ─────────────────────────────────────────────────────────────────────────────

describe("maskEmail", () => {
  it("masks a normal email address keeping first, last, and domain", () => {
    expect(maskEmail("admin@secureflow.test")).toBe("a***n@secureflow.test");
  });

  it("masks a single-character local-part email", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("masks a two-character local-part email", () => {
    expect(maskEmail("ab@example.com")).toBe("a***b@example.com");
  });

  it("masks emails with sub-domains", () => {
    expect(maskEmail("user@mail.company.io")).toBe("u***r@mail.company.io");
  });

  it("leaves non-email strings unchanged", () => {
    expect(maskEmail("user:user-123")).toBe("user:user-123");
    expect(maskEmail("BLOCK")).toBe("BLOCK");
  });

  it("handles empty string gracefully", () => {
    expect(maskEmail("")).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("looksLikeSecret", () => {
  it("detects a Bearer token", () => {
    expect(looksLikeSecret("Bearer ghp_abc123XYZ890abcdefghij123456")).toBe(true);
  });

  it("detects a GitHub PAT", () => {
    expect(looksLikeSecret("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")).toBe(true);
  });

  it("detects a JWT (three-segment base64 string)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcwMDAwMDAwMH0.abcdefghijklmnop";
    expect(looksLikeSecret(jwt)).toBe(true);
  });

  it("does not flag short, innocuous strings", () => {
    expect(looksLikeSecret("opened")).toBe(false);
    expect(looksLikeSecret("BLOCK")).toBe(false);
    expect(looksLikeSecret("user:user-123")).toBe(false);
  });

  it("returns false for empty or non-string values", () => {
    expect(looksLikeSecret("")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("maskSecretValue", () => {
  it("replaces a GitHub PAT embedded in a string with [REDACTED]", () => {
    const input = "Token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345";
    expect(maskSecretValue(input)).toContain("[REDACTED]");
    expect(maskSecretValue(input)).not.toContain("ghp_");
  });

  it("replaces a Bearer token with [REDACTED]", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
    const result = maskSecretValue(input);
    expect(result).toContain("[REDACTED]");
  });

  it("returns the original string if no secret pattern is found", () => {
    expect(maskSecretValue("PR scan completed")).toBe("PR scan completed");
    expect(maskSecretValue("mock-owner/mock-repo")).toBe("mock-owner/mock-repo");
  });

  it("handles empty or undefined input gracefully", () => {
    expect(maskSecretValue("")).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("hashIdentifier", () => {
  it("returns a 12-character hex string for a normal input", () => {
    const result = hashIdentifier("user-abc-123");
    expect(result).toHaveLength(12);
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic — same input always produces the same hash", () => {
    expect(hashIdentifier("user-abc-123")).toBe(hashIdentifier("user-abc-123"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashIdentifier("user-abc-123")).not.toBe(hashIdentifier("user-xyz-456"));
  });

  it("prepends the optional prefix separated by a colon", () => {
    const result = hashIdentifier("user-abc-123", "usr");
    expect(result.startsWith("usr:")).toBe(true);
    expect(result).toMatch(/^usr:[0-9a-f]{12}$/);
  });

  it("returns the input unchanged for empty or non-string values", () => {
    expect(hashIdentifier("")).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("sanitizeAuditMetadata", () => {
  it("passes through safe scalar values unchanged", () => {
    expect(sanitizeAuditMetadata(42)).toBe(42);
    expect(sanitizeAuditMetadata(true)).toBe(true);
    expect(sanitizeAuditMetadata(null)).toBe(null);
  });

  it("redacts object keys that match the sensitive key list", () => {
    const result = sanitizeAuditMetadata({
      password: "super-secret-123",
      token: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
      action: "PR_SCAN",
    }) as Record<string, unknown>;

    expect(result.password).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.action).toBe("PR_SCAN"); // safe — not in the redacted list
  });

  it("redacts keys regardless of casing and separators", () => {
    const result = sanitizeAuditMetadata({
      API_KEY: "my-api-key-value",
      "access-token": "tok_abc123",
    }) as Record<string, unknown>;

    expect(result["API_KEY"]).toBe("[REDACTED]");
    expect(result["access-token"]).toBe("[REDACTED]");
  });

  it("masks email strings found as values", () => {
    const result = sanitizeAuditMetadata({
      targetEmail: "admin@secureflow.test",
    }) as Record<string, unknown>;

    expect(result.targetEmail).toBe("a***n@secureflow.test");
  });

  it("recursively sanitises nested objects", () => {
    const result = sanitizeAuditMetadata({
      outerKey: "safe",
      nested: {
        deepToken: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
        userEmail: "rio@secureflow.test",
      },
    }) as Record<string, Record<string, unknown>>;

    expect(result.nested.deepToken).toBe("[REDACTED]");
    expect(result.nested.userEmail).toBe("r***o@secureflow.test");
  });

  it("recursively sanitises arrays within metadata", () => {
    const result = sanitizeAuditMetadata([
      "safe",
      "admin@secureflow.test",
      { password: "p@ssw0rd" },
    ]) as unknown[];

    expect(result[0]).toBe("safe");
    expect(result[1]).toBe("a***n@secureflow.test");
    expect((result[2] as Record<string, unknown>).password).toBe("[REDACTED]");
  });

  it("replaces secret-shaped string values even under non-sensitive keys", () => {
    const result = sanitizeAuditMetadata({
      message: "Token is: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
    }) as Record<string, unknown>;

    expect(result.message as string).toContain("[REDACTED]");
    expect(result.message as string).not.toContain("ghp_");
  });

  it("truncates deeply nested objects to prevent stack overflow", () => {
    // Build a deeply nested chain (depth > 8) to exercise the guard.
    const deep: Record<string, unknown> = { val: "leaf" };
    let current = deep;
    for (let i = 0; i < 10; i++) {
      const next: Record<string, unknown> = {};
      current.child = next;
      current = next;
    }
    current.val = "deep-leaf";

    // Should not throw and should contain "[TRUNCATED]" somewhere in output.
    const result = JSON.stringify(sanitizeAuditMetadata(deep));
    expect(result).toContain("TRUNCATED");
  });
});

// ──────────────────────────────────────────────────────────────────────────────

describe("sanitizeAuditLogInput", () => {
  it("uppercases and trims the action field", () => {
    const result = sanitizeAuditLogInput({
      action: "  admin_role_update  ",
      resource: "user:user-123",
    });
    expect(result.action).toBe("ADMIN_ROLE_UPDATE");
  });

  it('masks email addresses embedded in resource strings', () => {
    const result = sanitizeAuditLogInput({
      action: 'ADMIN_USER_DELETE',
      resource: 'user:admin@secureflow.test',
    });
    expect(result.resource).not.toContain('admin@secureflow.test');
    // The regex captures "user:admin" as the local-part, so maskEmail produces
    // first char "u" + "***" + last char "n" → "u***n@secureflow.test".
    expect(result.resource).toContain('u***n@secureflow.test');
  });

  it("sanitises the metadata object", () => {
    const result = sanitizeAuditLogInput({
      action: "ADMIN_ROLE_UPDATE",
      resource: "user:user-2",
      decision: "ADMIN",
      metadata: {
        targetEmail: "rio@secureflow.test",
        targetCodename: "Rio",
        oldRoles: ["USER"],
        newRole: "ADMIN",
        token: "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
      },
    });

    const meta = result.metadata as Record<string, unknown>;
    expect(meta.targetEmail).toBe("r***o@secureflow.test");
    expect(meta.token).toBe("[REDACTED]");
    expect(meta.targetCodename).toBe("Rio"); // safe — not sensitive
    expect(meta.newRole).toBe("ADMIN"); // safe
  });

  it("preserves userId and decision fields unchanged", () => {
    const result = sanitizeAuditLogInput({
      userId: "mock-admin-id",
      action: "ADMIN_USER_DELETE",
      resource: "user:user-3",
      decision: "DELETED",
    });

    expect(result.userId).toBe("mock-admin-id");
    expect(result.decision).toBe("DELETED");
  });

  it("handles null metadata gracefully", () => {
    const result = sanitizeAuditLogInput({
      action: "PR_SCAN",
      resource: "org/repo#42",
      metadata: null,
    });
    expect(result.metadata).toBeNull();
  });

  it("handles a resource string with no email without error", () => {
    const result = sanitizeAuditLogInput({
      action: "FINDING_TRIAGE",
      resource: "mock-owner/mock-repo:abc123def456",
    });
    expect(result.resource).toBe("mock-owner/mock-repo:abc123def456");
  });
});
