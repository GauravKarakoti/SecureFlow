import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

const mockRepoFindFirst = vi.fn();
const mockRepoFindMany = vi.fn();
const mockTriageUpsert = vi.fn();
const mockAuditCreate = vi.fn();
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({
    findingTriage: { upsert: mockTriageUpsert },
    auditLog: { create: mockAuditCreate },
  }),
);

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: { findFirst: () => mockRepoFindFirst(), findMany: () => mockRepoFindMany() },
    findingTriage: { upsert: (args: unknown) => mockTriageUpsert(args) },
    auditLog: { create: (args: unknown) => mockAuditCreate(args) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => mockTransaction(cb),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/audit/user-filter-cache", () => ({
  invalidateCachedUserFilters: vi.fn(),
}));

import { setFindingStatus, setFindingStatuses } from "@/lib/actions/triage";

describe("Finding Triage Dismissal & Reopening (#1528)", () => {
  const FINGERPRINT = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  const REPO_ID = "repo-xyz-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-owner" } });
    mockRepoFindFirst.mockResolvedValue({ id: REPO_ID, fullName: "acme/backend" });
    mockRepoFindMany.mockResolvedValue([{ id: REPO_ID, fullName: "acme/backend" }]);
    mockTriageUpsert.mockResolvedValue({ id: "triage-1" });
    mockAuditCreate.mockResolvedValue({ id: "audit-1" });
  });

  describe("Happy Path - Dismiss finding", () => {
    it("dismisses an open finding with required reason and note, setting status to DISMISSED and logging audit", async () => {
      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
        reason: "ACCEPTED_RISK",
        note: "Approved by security team in JIRA-402",
      });

      expect(res.ok).toBe(true);
      expect(mockTriageUpsert).toHaveBeenCalledTimes(1);
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId: REPO_ID,
              fingerprint: FINGERPRINT,
            },
          },
          update: expect.objectContaining({
            status: "DISMISSED",
            dismissalReason: "ACCEPTED_RISK",
            note: "Approved by security team in JIRA-402",
            resolvedById: "user-owner",
            dismissedById: "user-owner",
            dismissedAt: expect.any(Date),
          }),
          create: expect.objectContaining({
            repositoryId: REPO_ID,
            fingerprint: FINGERPRINT,
            status: "DISMISSED",
            dismissalReason: "ACCEPTED_RISK",
            note: "Approved by security team in JIRA-402",
            resolvedById: "user-owner",
            dismissedById: "user-owner",
            dismissedAt: expect.any(Date),
          }),
        }),
      );

      expect(mockAuditCreate).toHaveBeenCalledTimes(1);
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING TRIAGE",
            decision: "DISMISSED",
            userId: "user-owner",
            metadata: expect.objectContaining({
              repositoryId: REPO_ID,
              fingerprint: FINGERPRINT,
              status: "DISMISSED",
              dismissalReason: "ACCEPTED_RISK",
              hasNote: true,
              note: "Approved by security team in JIRA-402",
            }),
          }),
        }),
      );
    });

    it("supports dismissal reasons: FALSE_POSITIVE, ACCEPTED_RISK, WONT_FIX", async () => {
      for (const reason of ["FALSE_POSITIVE", "ACCEPTED_RISK", "WONT_FIX"] as const) {
        mockTriageUpsert.mockClear();
        mockAuditCreate.mockClear();

        const res = await setFindingStatus({
          repositoryId: REPO_ID,
          fingerprint: FINGERPRINT,
          status: "DISMISSED",
          reason,
          note: `Valid reason: ${reason}`,
        });

        expect(res.ok).toBe(true);
        expect(mockTriageUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({
              dismissalReason: reason,
            }),
          }),
        );
      }
    });
  });

  describe("Validation & Optional Note", () => {
    it("accepts a dismissal reason without a note", async () => {
      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
        note: "",
      });

      expect(res.ok).toBe(true);
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ note: null }) }),
      );
      expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    });

    it("normalizes a whitespace-only note to null", async () => {
      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
        reason: "ACCEPTED_RISK",
        note: "    ",
      });

      expect(res.ok).toBe(true);
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ note: null }) }),
      );
    });

    it("requires a dismissal category", async () => {
      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Invalid dismissal reason category");
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });

    it("rejects invalid dismissal reason category", async () => {
      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
        reason: "INVALID_REASON" as any,
        note: "Some note",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Invalid dismissal reason category");
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });
  });

  describe("Ownership & Auth Guard", () => {
    it("refuses to triage or dismiss when user does not own the repository (403)", async () => {
      mockRepoFindFirst.mockResolvedValue(null);

      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
        note: "I do not own this repo",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Repository not found");
      expect(mockTriageUpsert).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      mockAuth.mockResolvedValue(null);

      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
        note: "No session",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Not authenticated");
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });
  });

  describe("Reversal - Reopening finding", () => {
    it("reopens a previously dismissed finding by resetting status to OPEN", async () => {
      const res = await setFindingStatus({
        repositoryId: REPO_ID,
        fingerprint: FINGERPRINT,
        status: "OPEN",
        note: "Reopening finding after code review",
      });

      expect(res.ok).toBe(true);
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId: REPO_ID,
              fingerprint: FINGERPRINT,
            },
          },
          update: expect.objectContaining({
            status: "OPEN",
            note: "Reopening finding after code review",
            dismissalReason: null,
            dismissedAt: null,
            dismissedById: null,
          }),
        }),
      );

      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING TRIAGE",
            decision: "OPEN",
            userId: "user-owner",
            metadata: expect.objectContaining({
              status: "OPEN",
              hasNote: true,
            }),
          }),
        }),
      );
    });
  });

  describe("Bulk Dismissal", () => {
    it("allows bulk dismissal with reason and note, applying the same status and reason to all findings", async () => {
      const items = [
        { repositoryId: REPO_ID, fingerprint: "fp-1" },
        { repositoryId: REPO_ID, fingerprint: "fp-2" },
      ];

      const res = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "WONT_FIX",
        note: "Legacy service scheduled for deprecation",
      });

      expect(res.ok).toBe(true);
      expect(res.updatedCount).toBe(2);
      expect(res.skippedCount).toBe(0);
      expect(mockTriageUpsert).toHaveBeenCalledTimes(2);
      expect(mockAuditCreate).toHaveBeenCalledTimes(2);
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId: REPO_ID,
              fingerprint: "fp-1",
            },
          },
          update: expect.objectContaining({
            status: "DISMISSED",
            dismissalReason: "WONT_FIX",
            note: "Legacy service scheduled for deprecation",
            dismissedById: "user-owner",
          }),
        }),
      );
      expect(mockTriageUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId: REPO_ID,
              fingerprint: "fp-2",
            },
          },
          update: expect.objectContaining({
            status: "DISMISSED",
            dismissalReason: "WONT_FIX",
            note: "Legacy service scheduled for deprecation",
            dismissedById: "user-owner",
          }),
        }),
      );
    });

    it("allows bulk dismissal without a note", async () => {
      const items = [{ repositoryId: REPO_ID, fingerprint: "fp-1" }];

      const res = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "WONT_FIX",
        note: "",
      });

      expect(res.ok).toBe(true);
      expect(res.updatedCount).toBe(1);
      expect(mockTriageUpsert).toHaveBeenCalledTimes(1);
    });

    it("skips findings in repositories the user cannot access and reports skippedCount with a clear message", async () => {
      // User only has access to REPO_ID, not "unauthorized-repo"
      mockRepoFindMany.mockResolvedValue([{ id: REPO_ID, fullName: "acme/backend" }]);

      const items = [
        { repositoryId: REPO_ID, fingerprint: "fp-accessible-1" },
        { repositoryId: "unauthorized-repo", fingerprint: "fp-inaccessible-1" },
        { repositoryId: REPO_ID, fingerprint: "fp-accessible-2" },
        { repositoryId: "unauthorized-repo", fingerprint: "fp-inaccessible-2" },
      ];

      const res = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "ACCEPTED_RISK",
        note: "Accepted for this sprint",
      });

      expect(res.ok).toBe(true);
      expect(res.updatedCount).toBe(2);
      expect(res.skippedCount).toBe(2);
      expect(res.warning).toContain("Skipped 2 finding(s)");
      expect(mockTriageUpsert).toHaveBeenCalledTimes(2);
      expect(mockAuditCreate).toHaveBeenCalledTimes(2);
    });

    it("fails when the user has access to NONE of the repositories", async () => {
      mockRepoFindMany.mockResolvedValue([]);

      const items = [
        { repositoryId: "unauthorized-repo", fingerprint: "fp-1" },
        { repositoryId: "unauthorized-repo", fingerprint: "fp-2" },
      ];

      const res = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Repository not found");
      expect(res.skippedCount).toBe(2);
      expect(res.updatedCount).toBe(0);
      expect(mockTriageUpsert).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it("rejects dismissal without a reason or with reason less than 5 characters", async () => {
      const items = [{ repositoryId: REPO_ID, fingerprint: "fp-1" }];

      // Missing reason
      const noReasonRes = await setFindingStatuses({
        items,
        status: "DISMISSED",
      });
      expect(noReasonRes.ok).toBe(false);
      expect(noReasonRes.error).toBe("Reason must be at least 5 characters");
      expect(mockTriageUpsert).not.toHaveBeenCalled();

      // Reason less than 5 characters
      const shortReasonRes = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "bad",
      });
      expect(shortReasonRes.ok).toBe(false);
      expect(shortReasonRes.error).toBe("Reason must be at least 5 characters");
      expect(mockTriageUpsert).not.toHaveBeenCalled();

      // Empty string reason
      const emptyReasonRes = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "   ",
      });
      expect(emptyReasonRes.ok).toBe(false);
      expect(emptyReasonRes.error).toBe("Reason must be at least 5 characters");
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });

    it("rejects invalid dismissal reason categories", async () => {
      const items = [{ repositoryId: REPO_ID, fingerprint: "fp-1" }];

      const res = await setFindingStatuses({
        items,
        status: "DISMISSED",
        reason: "SOMETHING_ELSE",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Invalid dismissal reason category");
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });

    it("rejects batch sizes exceeding the maximum limit with a clear message", async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        repositoryId: REPO_ID,
        fingerprint: `fp-${i}`,
      }));

      const res = await setFindingStatuses({
        items: tooMany,
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe("Too many findings");
      expect(mockRepoFindMany).not.toHaveBeenCalled();
      expect(mockTriageUpsert).not.toHaveBeenCalled();
    });
  });
});
