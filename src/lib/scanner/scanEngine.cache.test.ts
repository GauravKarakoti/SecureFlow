import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  scanPullRequest: vi.fn(),
  postScanCheckRun: vi.fn(),
  upsertSecureFlowComment: vi.fn(),
  auditLogCreate: vi.fn(),
  scanResultCreate: vi.fn(),
  getCachedScan: vi.fn(),
  setCachedScan: vi.fn(),
  getPolicyVersion: vi.fn(),
}));

vi.mock("@/lib/armor/scanner", () => ({
  scanner: {
    scanPullRequest: mocks.scanPullRequest,
    lastSkippedFiles: [],
  },
}));

vi.mock("./check-run", () => ({
  postScanCheckRun: mocks.postScanCheckRun,
}));

vi.mock("@/lib/github/sticky-comment", () => ({
  upsertSecureFlowComment: mocks.upsertSecureFlowComment,
  SECUREFLOW_COMMENT_MARKER: "<!-- secureflow -->",
}));

vi.mock("@/lib/github/app-auth", () => ({
  getGitHubAppCredentials: () => ({ appId: "1", privateKey: "k" }),
}));

vi.mock("octokit", () => ({
  App: class {
    getInstallationOctokit() {
      return Promise.resolve({
        rest: {
          repos: { getContent: vi.fn().mockRejectedValue(new Error("no ignore file")) },
          pulls: { get: vi.fn().mockResolvedValue({ data: { title: "PR" } }) },
        },
      });
    }
  },
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    findingTriage: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: "pr-1" }),
      upsert: vi.fn().mockResolvedValue({ id: "pr-1" }),
    },
    scanResult: { create: mocks.scanResultCreate },
    auditLog: { create: mocks.auditLogCreate },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/queue/scanQueue", () => ({
  updateScanJobProgress: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/policies/policy-cache", () => ({
  getPolicyVersion: mocks.getPolicyVersion,
}));

vi.mock("./scan-cache", async () => {
  const actual = await vi.importActual<any>("./scan-cache");
  return {
    ...actual,
    getCachedScan: mocks.getCachedScan,
    setCachedScan: mocks.setCachedScan,
  };
});

import { processScanJob } from "./scanEngine";
import type { ScanJobData } from "@/lib/queue/scanQueue";

describe("processScanJob caching behavior", () => {
  const jobData: ScanJobData = {
    scanJobId: "job-1",
    repositoryId: "repo-1",
    installationId: 42,
    repositoryFullName: "acme/api",
    prNumber: 7,
    headSha: "abcdef123456",
    baseRef: "main",
    fileChanges: [{ filename: "src/app.ts", patch: "@@ -1,1 +1,2 @@\n+const x = 1;" }],
    activePolicies: [{ id: "p1", description: "Flag secrets" }],
    customIgnores: [],
    customPlaceholders: [],
    userId: "user-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolicyVersion.mockResolvedValue("1");
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.setCachedScan.mockResolvedValue(undefined);
    mocks.scanPullRequest.mockResolvedValue([]);
    mocks.scanResultCreate.mockResolvedValue({ id: "res-1" });
    mocks.auditLogCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("calls scanner on cache miss and writes findings to scan cache", async () => {
    mocks.getCachedScan.mockResolvedValueOnce(null);
    mocks.scanPullRequest.mockResolvedValueOnce([
      {
        type: "Secret",
        severity: "CRITICAL",
        description: "Found secret",
        fileLocation: "src/app.ts",
        codeSnippet: "const x = 1;",
      },
    ]);

    const result = await processScanJob(jobData, undefined, { enrich: false });

    expect(mocks.scanPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.setCachedScan).toHaveBeenCalledTimes(1);
    expect(result.reusedFromCache).toBe(false);
    expect(result.vulnerabilitiesFound).toBe(1);

    // Verify audit log recorded without cache notice
    expect(mocks.auditLogCreate).toHaveBeenCalled();
    const auditCall = mocks.auditLogCreate.mock.calls[0][0];
    expect(auditCall.data.action).toBe("BACKGROUND SCAN COMPLETED");
    expect(auditCall.data.metadata.reusedFromCache).toBe(false);
  });

  it("reuses findings from cache on cache hit without calling scanner", async () => {
    const cachedFindings = [
      {
        type: "Secret",
        severity: "CRITICAL",
        description: "Cached secret finding",
        fileLocation: "src/app.ts",
        codeSnippet: "const x = 1;",
      },
    ];

    mocks.getCachedScan.mockResolvedValueOnce(cachedFindings);

    const result = await processScanJob(jobData, undefined, { enrich: false });

    expect(mocks.scanPullRequest).not.toHaveBeenCalled();
    expect(mocks.setCachedScan).not.toHaveBeenCalled();
    expect(result.reusedFromCache).toBe(true);
    expect(result.vulnerabilitiesFound).toBe(1);

    // Verify audit log recorded "reused from cache"
    expect(mocks.auditLogCreate).toHaveBeenCalled();
    const auditCall = mocks.auditLogCreate.mock.calls[0][0];
    expect(auditCall.data.action).toContain("REUSED FROM CACHE");
    expect(auditCall.data.metadata.reusedFromCache).toBe(true);
    expect(auditCall.data.metadata.cacheStatus).toBe("reused from cache");
  });
});
