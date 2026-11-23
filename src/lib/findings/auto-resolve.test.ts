import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoResolveFixedFindings, normalizeFilePath } from "./auto-resolve";

describe("autoResolveFixedFindings (#1869)", () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      scanResult: {
        findMany: vi.fn(),
      },
      findingTriage: {
        findMany: vi.fn(),
        upsert: vi.fn().mockResolvedValue({}),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
  });

  describe("normalizeFilePath", () => {
    it("normalizes path with line numbers and backslashes", () => {
      expect(normalizeFilePath("src\\auth\\login.ts:42")).toBe("src/auth/login.ts");
      expect(normalizeFilePath("./components/Button.tsx")).toBe("components/button.tsx");
      expect(normalizeFilePath("terraform/main.tf")).toBe("terraform/main.tf");
    });
  });

  describe("acceptance criteria verification", () => {
    const repositoryId = "repo-1";
    const pullRequestId = "pr-1";
    const headSha = "abc1234def5678";

    it("marks finding that disappears in next successful scan as RESOLVED with commit SHA", async () => {
      // Earlier scan had two findings: fp-fixed in file-1.ts, fp-staying in file-2.ts
      mockDb.scanResult.findMany.mockResolvedValue([
        {
          id: "scan-prev",
          createdAt: new Date("2026-11-18T10:00:00Z"),
          findings: [
            {
              fingerprint: "fp-fixed",
              fileLocation: "src/file-1.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
            {
              fingerprint: "fp-staying",
              fileLocation: "src/file-2.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
          ],
        },
      ]);

      // No existing triage (implicitly OPEN)
      mockDb.findingTriage.findMany.mockResolvedValue([]);

      // Current scan only finds fp-staying; fp-fixed is resolved
      const result = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        currentFindings: [{ fingerprint: "fp-staying", fileLocation: "src/file-2.ts" }],
        fileChanges: [{ filename: "src/file-1.ts" }, { filename: "src/file-2.ts" }],
        userId: "user-1",
        db: mockDb,
      });

      expect(result.resolvedCount).toBe(1);
      expect(result.resolvedFingerprints).toEqual(["fp-fixed"]);
      expect(mockDb.findingTriage.upsert).toHaveBeenCalledTimes(1);
      expect(mockDb.findingTriage.upsert).toHaveBeenCalledWith({
        where: {
          repositoryId_fingerprint: {
            repositoryId,
            fingerprint: "fp-fixed",
          },
        },
        create: expect.objectContaining({
          status: "RESOLVED",
          resolvedCommitSha: headSha,
          note: "Resolved by commit abc1234",
        }),
        update: expect.objectContaining({
          status: "RESOLVED",
          resolvedCommitSha: headSha,
          note: "Resolved by commit abc1234",
        }),
      });

      // Audit log entry created
      expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
      expect(mockDb.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "FINDING RESOLVED",
            decision: "RESOLVED",
            metadata: expect.objectContaining({
              resolvedCommitSha: headSha,
            }),
          }),
        }),
      );
    });

    it("never resolves findings when scan is failed or partial", async () => {
      // Test isFailedScan: true
      const failedResult = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        isFailedScan: true,
        currentFindings: [],
        db: mockDb,
      });

      expect(failedResult.resolvedCount).toBe(0);
      expect(mockDb.scanResult.findMany).not.toHaveBeenCalled();
      expect(mockDb.findingTriage.upsert).not.toHaveBeenCalled();

      // Test isPartialScan: true (some files were skipped)
      const partialResult = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        isPartialScan: true,
        currentFindings: [],
        db: mockDb,
      });

      expect(partialResult.resolvedCount).toBe(0);
      expect(mockDb.scanResult.findMany).not.toHaveBeenCalled();
      expect(mockDb.findingTriage.upsert).not.toHaveBeenCalled();
    });

    it("keeps dismissed findings in dismissed status and does not resolve them", async () => {
      mockDb.scanResult.findMany.mockResolvedValue([
        {
          id: "scan-prev",
          createdAt: new Date("2026-11-18T10:00:00Z"),
          findings: [
            {
              fingerprint: "fp-dismissed",
              fileLocation: "src/file-1.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
            {
              fingerprint: "fp-open",
              fileLocation: "src/file-2.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
          ],
        },
      ]);

      // fp-dismissed was previously DISMISSED by user
      mockDb.findingTriage.findMany.mockResolvedValue([
        {
          fingerprint: "fp-dismissed",
          status: "DISMISSED",
          dismissalReason: "FALSE_POSITIVE",
        },
      ]);

      // Both disappeared in new scan
      const result = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        currentFindings: [],
        fileChanges: [{ filename: "src/file-1.ts" }, { filename: "src/file-2.ts" }],
        db: mockDb,
      });

      expect(result.resolvedCount).toBe(1);
      expect(result.resolvedFingerprints).toEqual(["fp-open"]);
      expect(result.skippedDismissedCount).toBe(1);

      // Only fp-open was upserted to RESOLVED
      expect(mockDb.findingTriage.upsert).toHaveBeenCalledTimes(1);
      expect(mockDb.findingTriage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_fingerprint: {
              repositoryId,
              fingerprint: "fp-open",
            },
          },
        }),
      );
    });

    it("leaves still-present findings unchanged", async () => {
      mockDb.scanResult.findMany.mockResolvedValue([
        {
          id: "scan-prev",
          createdAt: new Date("2026-11-18T10:00:00Z"),
          findings: [
            {
              fingerprint: "fp-still-here",
              fileLocation: "src/file-1.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
          ],
        },
      ]);

      mockDb.findingTriage.findMany.mockResolvedValue([]);

      const result = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        currentFindings: [{ fingerprint: "fp-still-here", fileLocation: "src/file-1.ts" }],
        fileChanges: [{ filename: "src/file-1.ts" }],
        db: mockDb,
      });

      expect(result.resolvedCount).toBe(0);
      expect(result.skippedStillPresentCount).toBe(1);
      expect(mockDb.findingTriage.upsert).not.toHaveBeenCalled();
    });

    it("skips auto-resolution if file was not changed in the current PR diff", async () => {
      mockDb.scanResult.findMany.mockResolvedValue([
        {
          id: "scan-prev",
          createdAt: new Date("2026-11-18T10:00:00Z"),
          findings: [
            {
              fingerprint: "fp-other-file",
              fileLocation: "src/other.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
          ],
        },
      ]);

      mockDb.findingTriage.findMany.mockResolvedValue([]);

      // Current scan only touched src/touched.ts; src/other.ts was not in PR changes
      const result = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        currentFindings: [],
        fileChanges: [{ filename: "src/touched.ts" }],
        db: mockDb,
      });

      expect(result.resolvedCount).toBe(0);
      expect(mockDb.findingTriage.upsert).not.toHaveBeenCalled();
    });

    it("never auto-resolves findings when isPartialScan is true (#1981)", async () => {
      mockDb.scanResult.findMany.mockResolvedValue([
        {
          id: "scan-prev",
          createdAt: new Date("2026-11-18T10:00:00Z"),
          findings: [
            {
              fingerprint: "fp-fixed",
              fileLocation: "src/file-1.ts",
              createdAt: new Date("2026-11-18T10:00:00Z"),
            },
          ],
        },
      ]);

      mockDb.findingTriage.findMany.mockResolvedValue([]);

      const result = await autoResolveFixedFindings({
        repositoryId,
        pullRequestId,
        headSha,
        currentFindings: [],
        fileChanges: [{ filename: "src/file-1.ts" }],
        isPartialScan: true,
        db: mockDb,
      });

      expect(result.resolvedCount).toBe(0);
      expect(mockDb.findingTriage.upsert).not.toHaveBeenCalled();
    });
  });
});
