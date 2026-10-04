import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanPullRequest: vi.fn(),
  checksCreate: vi.fn(),
  createComment: vi.fn(),
  updateScanJobProgress: vi.fn(),
  explain: vi.fn(),
  getContent: vi.fn(),
  pullsGet: vi.fn(),
}));

vi.mock("@/lib/armor/scanner", () => ({
  scanner: { scanPullRequest: mocks.scanPullRequest },
  parseSecureFlowIgnore: (content: string) => ({
    ignoredPaths: content
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    placeholders: [],
  }),
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
          repos: { getContent: mocks.getContent },
          pulls: { get: mocks.pullsGet },
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

  describe("ignore configuration", () => {
    const quiet = { report: false, persist: false, enrich: false };
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
    const scanCall = () => mocks.scanPullRequest.mock.calls[0];
    const expectScannedWith = (ignores: string[], placeholders: string[] = []) =>
      expect(scanCall()).toEqual([expect.any(Array), expect.any(Array), ignores, placeholders]);

    beforeEach(() => {
      mocks.getContent.mockReset();
      mocks.pullsGet.mockReset();
      mocks.scanPullRequest.mockResolvedValue([]);
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("reads .secureflowignore from the base branch named in the job", async () => {
      mocks.getContent.mockResolvedValue({ data: { content: base64("docs/**\ntests/**") } });

      await processScanJob({ ...jobData, baseRef: "main" } as ScanJobData, undefined, quiet);

      expect(mocks.pullsGet).not.toHaveBeenCalled();
      expect(mocks.getContent).toHaveBeenCalledWith({
        owner: "acme",
        repo: "api",
        path: ".secureflowignore",
        ref: "main",
      });
      expectScannedWith(["docs/**", "tests/**"]);
    });

    it("looks the base branch up from the pull request when the job does not name one", async () => {
      mocks.pullsGet.mockResolvedValue({ data: { base: { ref: "develop" } } });
      mocks.getContent.mockResolvedValue({ data: { content: base64("docs/**") } });

      await processScanJob(jobData, undefined, quiet);

      expect(mocks.pullsGet).toHaveBeenCalledWith({ owner: "acme", repo: "api", pull_number: 7 });
      expect(mocks.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: "develop" }));
      expectScannedWith(["docs/**"]);
    });

    it("is not switched off by a .secureflowignore the pull request adds on its own branch", async () => {
      // Nothing on the base branch; the head commit (`abc123`) adds a file that
      // ignores everything. Only a read at the head would ever see it.
      mocks.getContent.mockImplementation(async ({ ref }: { ref: string }) => {
        if (ref === "main") throw notFound();
        return { data: { content: base64("**\n[placeholders]\nAKIA") } };
      });

      await processScanJob({ ...jobData, baseRef: "main" } as ScanJobData, undefined, quiet);

      expectScannedWith([]);
      for (const [params] of mocks.getContent.mock.calls) {
        expect(params.ref).not.toBe("abc123");
      }
    });

    it("keeps server-supplied ignores in addition to the repository's own", async () => {
      mocks.getContent.mockResolvedValue({ data: { content: base64("docs/**") } });

      await processScanJob(
        { ...jobData, baseRef: "main", customIgnores: ["vendor/**"] } as ScanJobData,
        undefined,
        quiet,
      );

      expectScannedWith(["vendor/**", "docs/**"]);
    });

    it("scans without ignore rules when no base branch can be determined", async () => {
      mocks.pullsGet.mockRejectedValue(new Error("GitHub is down"));

      await processScanJob(jobData, undefined, quiet);

      expect(mocks.getContent).not.toHaveBeenCalled();
      expectScannedWith([]);
    });
  });
});
