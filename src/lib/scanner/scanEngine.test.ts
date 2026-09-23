import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanPullRequest: vi.fn(),
  checksCreate: vi.fn(),
  createComment: vi.fn(),
  updateScanJobProgress: vi.fn(),
  explain: vi.fn(),
}));

vi.mock("@/lib/armor/scanner", () => ({
  scanner: { scanPullRequest: mocks.scanPullRequest },
}));
vi.mock("@/lib/armor/iq", () => ({
  iq: {
    evaluateFindings: (findings: Array<{ severity: string }>) =>
      findings.some((f) => f.severity === "CRITICAL") ? "BLOCKED" : "PASS",
  },
}));
vi.mock("@/ai/flows/developer-receives-ai-security-explanations", () => ({
  developerReceivesAISecurityExplanations: mocks.explain,
}));
vi.mock("@/lib/queue/worker", () => ({
  getGitHubAppCredentials: () => ({ appId: "1", privateKey: "key" }),
}));
vi.mock("@/lib/queue/scanQueue", () => ({
  updateScanJobProgress: mocks.updateScanJobProgress,
}));
vi.mock("@/lib/prisma", () => ({
  default: { findingTriage: { findMany: vi.fn().mockResolvedValue([]) } },
}));
vi.mock("octokit", () => ({
  App: class {
    async getInstallationOctokit() {
      return {
        rest: {
          checks: { create: mocks.checksCreate },
          issues: { createComment: mocks.createComment },
        },
      };
    }
  },
}));

import { processScanJob, ScanIncompleteError } from "./scanEngine";
import type { ScanJobData } from "@/lib/queue/scanQueue";

/** Twelve files, so the engine scans them in two chunks (10 + 2). */
const fileChanges = Array.from({ length: 12 }, (_, i) => ({
  filename: `src/file-${i}.ts`,
  patch: `+const value${i} = ${i};`,
}));

const jobData = {
  scanJobId: "job-1",
  repositoryId: "",
  installationId: 42,
  repositoryFullName: "acme/api",
  prNumber: 7,
  headSha: "abc123",
  fileChanges,
  activePolicies: [],
  customIgnores: [],
  customPlaceholders: [],
} as unknown as ScanJobData;

describe("processScanJob chunk failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateScanJobProgress.mockResolvedValue(undefined);
    mocks.explain.mockResolvedValue({
      explanation: "e",
      remediationSuggestions: "r",
      promptInjectionSuspected: false,
    });
  });

  it("fails the scan instead of reporting PASS when the analysis engine is unavailable", async () => {
    mocks.scanPullRequest.mockRejectedValue(
      new Error("ScanFailedAnalysisEngineUnavailable: LLM scan failed after all retries."),
    );

    const run = processScanJob(jobData);

    await expect(run).rejects.toBeInstanceOf(ScanIncompleteError);
    await expect(run).rejects.toThrow(/10 file\(s\) could not be analysed/);
    expect(mocks.checksCreate).not.toHaveBeenCalled();
  });

  it("fails the scan when a later chunk fails, even though an earlier one succeeded", async () => {
    mocks.scanPullRequest.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("429"));

    const error = await processScanJob(jobData, undefined, { report: false, persist: false }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ScanIncompleteError);
    expect((error as ScanIncompleteError).failedFiles).toEqual([
      "src/file-10.ts",
      "src/file-11.ts",
    ]);
  });

  it("still completes and reports when every chunk scans", async () => {
    mocks.scanPullRequest.mockResolvedValue([]);

    const result = await processScanJob(jobData);

    expect(mocks.scanPullRequest).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scannedFiles: 12, vulnerabilitiesFound: 0, verdict: "PASS" });
    expect(mocks.checksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success", head_sha: "abc123" }),
    );
  });
});
