import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeFingerprint } from "@/lib/armor/fingerprint";
import { triagedVerdict, type StoredTriageFinding } from "@/lib/triage/verdict";
import { setFindingStatus } from "@/lib/actions/triage";
import type { GateConfig } from "@/lib/scanner/gate-config";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

const mockRepoFindFirst = vi.fn();
const mockTriageUpsert = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: { findFirst: () => mockRepoFindFirst() },
    findingTriage: { upsert: (args: unknown) => mockTriageUpsert(args) },
    auditLog: { create: (args: unknown) => mockAuditCreate(args) },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit/user-filter-cache", () => ({
  invalidateCachedUserFilters: vi.fn(),
}));

describe("Finding Triage: Dismiss and Suppress Pipeline Integration (#1702)", () => {
  const repositoryId = "repo-1702-test";
  const gate: GateConfig = { blockOn: "HIGH", reviewOn: "MEDIUM" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-reviewer" } });
    mockRepoFindFirst.mockResolvedValue({ id: repositoryId, fullName: "acme/repo-security" });
    mockTriageUpsert.mockResolvedValue({ id: "triage-1702" });
    mockAuditCreate.mockResolvedValue({ id: "audit-1702" });
  });

  describe("1. Fingerprint Stability across line shifts", () => {
    it("generates identical fingerprints when finding moves to a different line", () => {
      const file = "src/payment/checkout.ts";
      const type = "VULNERABILITY";
      const snippet = "const token = request.headers['x-api-key'];";

      const fpLine10 = computeFingerprint(repositoryId, file, type, snippet);
      const fpLine95 = computeFingerprint(repositoryId, file, type, snippet);

      expect(fpLine10).toBe(fpLine95);
      expect(fpLine10).toHaveLength(64);
    });

    it("generates different fingerprints for different finding types in the same file and snippet", () => {
      const file = "src/payment/checkout.ts";
      const snippet = "const key = 'secret_123';";

      const fpVuln = computeFingerprint(repositoryId, file, "VULNERABILITY", snippet);
      const fpSecret = computeFingerprint(repositoryId, file, "SECRET", snippet);

      expect(fpVuln).not.toBe(fpSecret);
    });
  });

  describe("2. Triage Dismiss Action Validation & Authorization Guard", () => {
    const testFp = "fingerprint-1702-abc";

    it("rejects dismissal with a reason shorter than 5 characters", async () => {
      const result = await setFindingStatus({
        repositoryId,
        fingerprint: testFp,
        status: "DISMISSED",
        reason: "inv",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/at least 5 characters/i);
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });

    it("rejects triage when user does not have access to the repository", async () => {
      mockRepoFindFirst.mockResolvedValue(null);

      const result = await setFindingStatus({
        repositoryId,
        fingerprint: testFp,
        status: "DISMISSED",
        reason: "ACCEPTED_RISK",
        note: "Accepted in backlog JIRA-101",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Repository not found/i);
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });

    it("successfully dismisses finding with valid reason and records audit log", async () => {
      const result = await setFindingStatus({
        repositoryId,
        fingerprint: testFp,
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
        note: "Verified test stub, not live credential",
      });

      expect(result.ok).toBe(true);
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repositoryId_fingerprint: { repositoryId, fingerprint: testFp } },
          update: expect.objectContaining({
            status: "DISMISSED",
            dismissalReason: "FALSE_POSITIVE",
            dismissedById: "user-reviewer",
          }),
        }),
      );
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-reviewer",
            decision: "DISMISSED",
          }),
        }),
      );
    });
  });

  describe("3. Scan-time Suppression and Re-scan Verdict", () => {
    const file = "src/routes/auth.ts";
    const highSnippet = "eval(userInput);";
    const fpHigh = computeFingerprint(repositoryId, file, "VULNERABILITY", highSnippet);

    const highFinding: StoredTriageFinding = {
      fingerprint: fpHigh,
      type: "VULNERABILITY",
      severity: "HIGH",
      fileLocation: file,
      codeSnippet: highSnippet,
      explanation: "Remote code execution risk via eval",
      lineStart: 15,
      lineEnd: 15,
    };

    it("happy path: PR with HIGH finding returns BLOCKED; returns PASS once suppressed", () => {
      // 1. Initial scan: no suppressions -> BLOCKED
      const initial = triagedVerdict([highFinding], new Set(), gate);
      expect(initial.decision).toBe("BLOCKED");
      expect(initial.active).toHaveLength(1);

      // 2. Finding is dismissed -> suppressed
      const suppressedSet = new Set([fpHigh]);
      const triaged = triagedVerdict([highFinding], suppressedSet, gate);
      expect(triaged.decision).toBe("PASS");
      expect(triaged.active).toHaveLength(0);
      expect(triaged.riskScore).toBe(0);
    });

    it("line shift edge case: code moved to line 85 remains suppressed", () => {
      const shiftedFinding: StoredTriageFinding = {
        ...highFinding,
        lineStart: 85,
        lineEnd: 85,
      };

      const suppressedSet = new Set([fpHigh]);
      const verdict = triagedVerdict([shiftedFinding], suppressedSet, gate);
      expect(verdict.decision).toBe("PASS");
      expect(verdict.active).toHaveLength(0);
    });

    it("unsuppressed finding edge case: a different finding in the same file is not suppressed", () => {
      const diffSnippet = "sql.raw(`SELECT * FROM users WHERE id = ${id}`);";
      const fpSql = computeFingerprint(repositoryId, file, "VULNERABILITY", diffSnippet);

      const otherFinding: StoredTriageFinding = {
        fingerprint: fpSql,
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: file,
        codeSnippet: diffSnippet,
        explanation: "SQL injection vulnerability",
        lineStart: 25,
        lineEnd: 25,
      };

      // Only fpHigh is dismissed
      const suppressedSet = new Set([fpHigh]);
      const verdict = triagedVerdict([highFinding, otherFinding], suppressedSet, gate);

      expect(verdict.decision).toBe("BLOCKED");
      expect(verdict.active).toHaveLength(1);
      expect(verdict.active[0].codeSnippet).toBe(diffSnippet);
    });

    it("restore / reopening: restoring finding returns verdict back to BLOCKED", () => {
      // Once finding is reopened/restored, it is removed from suppressedSet
      const restoredSuppressedSet = new Set<string>();
      const restoredVerdict = triagedVerdict([highFinding], restoredSuppressedSet, gate);

      expect(restoredVerdict.decision).toBe("BLOCKED");
      expect(restoredVerdict.active).toHaveLength(1);
    });
  });
});
