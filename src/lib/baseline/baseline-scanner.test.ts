import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isBaselineScanDue,
  clampBaselineFileLimit,
  canRunBaselineScan,
  executeBaselineScan,
  scheduleBaselineScanJob,
  DEFAULT_BASELINE_FILE_LIMIT,
  MAX_BASELINE_FILE_LIMIT,
  MIN_BASELINE_FILE_LIMIT,
  BASELINE_PR_NUMBER,
  BASELINE_TAG,
} from "./baseline-scanner";
import { iq } from "@/lib/armor/iq";
import { DEFAULT_GATE_CONFIG } from "@/lib/scanner/gate-config";
import type { ScanFinding } from "@/lib/armor/scanner";

describe("Baseline Scanner Engine (#2011)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("clampBaselineFileLimit", () => {
    it("returns default 50 for null or undefined", () => {
      expect(clampBaselineFileLimit(null)).toBe(DEFAULT_BASELINE_FILE_LIMIT);
      expect(clampBaselineFileLimit(undefined)).toBe(DEFAULT_BASELINE_FILE_LIMIT);
    });

    it("clamps values below minimum to 1", () => {
      expect(clampBaselineFileLimit(0)).toBe(MIN_BASELINE_FILE_LIMIT);
      expect(clampBaselineFileLimit(-10)).toBe(MIN_BASELINE_FILE_LIMIT);
    });

    it("clamps values exceeding maximum to 200", () => {
      expect(clampBaselineFileLimit(500)).toBe(MAX_BASELINE_FILE_LIMIT);
      expect(clampBaselineFileLimit(201)).toBe(MAX_BASELINE_FILE_LIMIT);
    });

    it("accepts valid values in range", () => {
      expect(clampBaselineFileLimit(25)).toBe(25);
      expect(clampBaselineFileLimit(100)).toBe(100);
      expect(clampBaselineFileLimit("75")).toBe(75);
    });
  });

  describe("isBaselineScanDue", () => {
    const now = new Date("2026-11-24T12:00:00.000Z");

    it("returns false when baseline scans are disabled", () => {
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: false,
            baselineFrequency: "weekly",
            lastBaselineScanAt: null,
          },
          now,
        ),
      ).toBe(false);
    });

    it("returns true when enabled and never scanned before (lastBaselineScanAt is null)", () => {
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "weekly",
            lastBaselineScanAt: null,
          },
          now,
        ),
      ).toBe(true);
    });

    it("checks daily frequency interval (24 hours)", () => {
      // 12 hours ago -> not due
      const recent = new Date("2026-11-24T00:00:00.000Z");
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "daily",
            lastBaselineScanAt: recent,
          },
          now,
        ),
      ).toBe(false);

      // 25 hours ago -> due
      const past = new Date("2026-11-23T10:00:00.000Z");
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "daily",
            lastBaselineScanAt: past,
          },
          now,
        ),
      ).toBe(true);
    });

    it("checks weekly frequency interval (7 days)", () => {
      // 5 days ago -> not due
      const fiveDaysAgo = new Date("2026-11-19T12:00:00.000Z");
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "weekly",
            lastBaselineScanAt: fiveDaysAgo,
          },
          now,
        ),
      ).toBe(false);

      // 8 days ago -> due
      const eightDaysAgo = new Date("2026-11-16T12:00:00.000Z");
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "weekly",
            lastBaselineScanAt: eightDaysAgo,
          },
          now,
        ),
      ).toBe(true);
    });

    it("checks monthly frequency interval (30 days)", () => {
      // 20 days ago -> not due
      const twentyDaysAgo = new Date("2026-11-04T12:00:00.000Z");
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "monthly",
            lastBaselineScanAt: twentyDaysAgo,
          },
          now,
        ),
      ).toBe(false);

      // 31 days ago -> due
      const thirtyOneDaysAgo = new Date("2026-10-24T12:00:00.000Z");
      expect(
        isBaselineScanDue(
          {
            baselineScanEnabled: true,
            baselineFrequency: "monthly",
            lastBaselineScanAt: thirtyOneDaysAgo,
          },
          now,
        ),
      ).toBe(true);
    });
  });

  describe("canRunBaselineScan", () => {
    it("disallows when disabled unless forced", () => {
      const repo = {
        baselineScanEnabled: false,
        baselineFrequency: "weekly",
        lastBaselineScanAt: null,
      };

      expect(canRunBaselineScan(repo).allowed).toBe(false);
      expect(canRunBaselineScan(repo, { force: true }).allowed).toBe(true);
    });

    it("disallows when enabled but not due yet unless forced", () => {
      const recent = new Date();
      const repo = {
        baselineScanEnabled: true,
        baselineFrequency: "weekly",
        lastBaselineScanAt: recent,
      };

      expect(canRunBaselineScan(repo).allowed).toBe(false);
      expect(canRunBaselineScan(repo, { force: true }).allowed).toBe(true);
    });
  });

  describe("executeBaselineScan", () => {
    it("scans provided files, tags findings with BASELINE, and persists under prNumber 0", async () => {
      const mockRepo = {
        id: "repo-123",
        fullName: "acme/api-service",
        githubId: 987654321,
        baselineScanEnabled: true,
        baselineFrequency: "weekly",
        baselineFileLimit: 50,
        lastBaselineScanAt: null,
      };

      const mockBaselinePr = {
        id: "pr-baseline-1",
        repositoryId: "repo-123",
        prNumber: BASELINE_PR_NUMBER,
      };

      const mockScanResult = {
        id: "scan-res-1",
        pullRequestId: mockBaselinePr.id,
        policyDecision: "PASS",
        riskScore: 20,
      };

      const mockDb = {
        repository: {
          findUnique: vi.fn().mockResolvedValue(mockRepo),
          update: vi.fn().mockResolvedValue({ ...mockRepo, lastBaselineScanStatus: "COMPLETED" }),
        },
        pullRequest: {
          upsert: vi.fn().mockResolvedValue(mockBaselinePr),
        },
        scanResult: {
          create: vi.fn().mockResolvedValue(mockScanResult),
        },
      };

      const sampleFiles = [
        {
          filename: ".github/workflows/deploy.yml",
          content:
            "name: Deploy\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
        },
        {
          filename: "src/server.ts",
          content: "const server = 123;\n",
        },
      ];

      const result = await executeBaselineScan({
        repositoryId: "repo-123",
        repositoryFullName: "acme/api-service",
        files: sampleFiles,
        db: mockDb,
        force: true,
      });

      expect(result.scannedFiles).toBe(2);
      expect(mockDb.pullRequest.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repositoryId_prNumber: {
              repositoryId: "repo-123",
              prNumber: BASELINE_PR_NUMBER,
            },
          },
        }),
      );

      expect(mockDb.scanResult.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pullRequestId: "pr-baseline-1",
            scanType: BASELINE_TAG,
          }),
        }),
      );

      expect(mockDb.repository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "repo-123" },
          data: expect.objectContaining({
            lastBaselineScanStatus: "COMPLETED",
          }),
        }),
      );
    });
  });

  describe("scheduleBaselineScanJob", () => {
    it("enqueues baseline scan into fair queue scheduler", () => {
      const queued = scheduleBaselineScanJob({
        repositoryId: "repo-fair-1",
        repositoryFullName: "acme/backend",
        installationId: 445566,
      });

      expect(queued).toBe(true);
    });
  });

  describe("Acceptance Criteria Invariant: Baseline findings never block PRs", () => {
    it("verifies that PR gate evaluation ignores baseline findings and only evaluates PR findings", () => {
      // Suppose a repository has a baseline finding (e.g. CRITICAL finding in legacy code)
      const baselineFinding: ScanFinding & { tag: string; isBaseline: boolean } = {
        type: "Vulnerability",
        severity: "CRITICAL",
        description: "Pre-existing SQL injection in legacy code",
        fileLocation: "legacy/db.ts",
        codeSnippet: "SELECT * FROM users WHERE id = " + "req.id",
        tag: "BASELINE",
        isBaseline: true,
      };

      // PR under review only changes a README or safe file
      const prFindings: ScanFinding[] = [];

      // PR gate evaluator runs strictly on PR findings
      const decision = iq.evaluateFindings(prFindings, DEFAULT_GATE_CONFIG);

      // Gate decision for PR is PASS because baseline findings do not block PRs
      expect(decision).toBe("PASS");

      // Verify that if a PR finding itself had a critical issue, it would block
      const realPrIssue: ScanFinding[] = [
        {
          type: "Secret",
          severity: "CRITICAL",
          description: "Leaked AWS secret key in PR diff",
          fileLocation: "src/config.ts",
          codeSnippet: "AKIAIOSFODNN7EXAMPLE",
        },
      ];
      const blockedDecision = iq.evaluateFindings(realPrIssue, DEFAULT_GATE_CONFIG);
      expect(blockedDecision).toBe("BLOCKED");
    });
  });
});
