import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanPullRequest: vi.fn(),
  checksCreate: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  listComments: vi.fn(),
  updateScanJobProgress: vi.fn(),
  explain: vi.fn(),
  getContent: vi.fn(),
  pullsGet: vi.fn(),
}));

vi.mock("@/lib/armor/scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/armor/scanner")>();
  return {
    ...actual,
    scanner: { scanPullRequest: mocks.scanPullRequest },
    parseSecureFlowIgnore: (content: string) => ({
      ignoredPaths: content
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      placeholders: [],
    }),
  };
});
vi.mock("@/lib/armor/iq", () => ({
  iq: {
    evaluateFindings: (findings: Array<{ severity: string }>) =>
      findings.some((f) => f.severity === "CRITICAL") ? "BLOCKED" : "PASS",
  },
}));
vi.mock("@/ai/flows/developer-receives-ai-security-explanations", () => ({
  developerReceivesAISecurityExplanations: mocks.explain,
}));
vi.mock("@/lib/github/app-auth", () => ({
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
          issues: {
            createComment: mocks.createComment,
            updateComment: mocks.updateComment,
            listComments: mocks.listComments,
          },
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

  it("posts sticky PR comment with marker and headSha when findings exist", async () => {
    mocks.scanPullRequest
      .mockResolvedValueOnce([
        {
          ruleId: "SF-001",
          severity: "HIGH",
          message: "Hardcoded secret",
          file: "src/file-0.ts",
          startLine: 1,
          endLine: 1,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.listComments.mockResolvedValue({ data: [] });
    mocks.createComment.mockResolvedValue({ data: { id: 101 } });

    await processScanJob(jobData);

    expect(mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "api",
        issue_number: 7,
        body: expect.stringContaining("<!-- secureflow-report -->"),
      }),
    );
    expect(mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Scanned commit: `abc123`"),
      }),
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

  describe("Zero analyzed files handling (PR #174 regression)", () => {
    it("handles an empty diff (0 changed files) with neutral check run and 'Nothing to scan: no changed files' comment", async () => {
      mocks.scanPullRequest.mockResolvedValue([]);

      const result = await processScanJob(
        { ...jobData, fileChanges: [] } as ScanJobData,
        undefined,
        { report: true, persist: false, enrich: false },
      );

      expect(result.scannedFiles).toBe(0);
      expect(result.zeroScanReason).toBe("no changed files");

      // Verify check run was created with neutral conclusion and emptyReason
      expect(mocks.checksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: "neutral",
          output: expect.objectContaining({
            title: "Nothing to scan",
            summary: "Nothing to scan: no changed files.",
          }),
        }),
      );

      // Verify PR comment was posted with Nothing to scan and NO success wording
      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mocks.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("Nothing to scan: no changed files.");
      expect(commentBody).not.toContain("Scan completed successfully");
      expect(commentBody).not.toContain("No security vulnerabilities detected in scanned files");
    });

    it("handles unsupported file types (e.g. README.md) with neutral check run and 'Nothing to scan: unsupported file types'", async () => {
      mocks.scanPullRequest.mockResolvedValue([]);

      const mdFiles = [
        {
          filename: "README.md",
          patch: "@@ -1 +1 @@\n+# Documentation update",
        },
      ];

      const result = await processScanJob(
        { ...jobData, fileChanges: mdFiles } as ScanJobData,
        undefined,
        { report: true, persist: false, enrich: false },
      );

      expect(result.scannedFiles).toBe(0);
      expect(result.zeroScanReason).toBe("unsupported file types");

      expect(mocks.checksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: "neutral",
          output: expect.objectContaining({
            title: "Nothing to scan",
            summary: "Nothing to scan: unsupported file types.",
          }),
        }),
      );

      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mocks.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("Nothing to scan: unsupported file types.");
      expect(commentBody).not.toContain("Scan completed successfully");
      expect(commentBody).not.toContain("No security vulnerabilities detected in scanned files");
    });

    it("handles all paths ignored with neutral check run and 'Nothing to scan: all paths ignored'", async () => {
      mocks.scanPullRequest.mockResolvedValue([]);

      const nodeModulesFiles = [
        {
          filename: "node_modules/library/index.js",
          patch: "@@ -0,0 +1 @@\n+const x = 1;",
        },
      ];

      const result = await processScanJob(
        { ...jobData, fileChanges: nodeModulesFiles } as ScanJobData,
        undefined,
        { report: true, persist: false, enrich: false },
      );

      expect(result.scannedFiles).toBe(0);
      expect(result.zeroScanReason).toBe("all paths ignored");

      expect(mocks.checksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: "neutral",
          output: expect.objectContaining({
            title: "Nothing to scan",
            summary: "Nothing to scan: all paths ignored.",
          }),
        }),
      );

      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mocks.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("Nothing to scan: all paths ignored.");
      expect(commentBody).not.toContain("Scan completed successfully");
      expect(commentBody).not.toContain("No security vulnerabilities detected in scanned files");
    });
  });

  describe("PR comment confidence threshold and hidden count (#1924)", () => {
    const base64 = (text: string) => Buffer.from(text).toString("base64");

    it("hides findings below repository threshold and states the hidden count in PR comment", async () => {
      // Mock .secureflow.json from base branch with minCommentConfidence: "HIGH"
      mocks.getContent.mockImplementation(({ path }: { path: string }) => {
        if (path === ".secureflow.json") {
          return Promise.resolve({
            data: {
              content: base64(
                JSON.stringify({
                  confidence: { minCommentConfidence: "HIGH" },
                }),
              ),
            },
          });
        }
        return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
      });
      mocks.pullsGet.mockResolvedValue({ data: { base: { ref: "main" } } });

      const findings = [
        {
          type: "Secret",
          severity: "CRITICAL",
          confidence: "HIGH",
          confidenceReason: "Active API key in production file",
          description: "High confidence production leak",
          fileLocation: "src/prod.ts",
          codeSnippet: "KEY = 123",
        },
        {
          type: "Vulnerability",
          severity: "MEDIUM",
          confidence: "LOW",
          confidenceReason: "Uncertain test fixture token",
          description: "Low confidence test mock",
          fileLocation: "tests/mock.ts",
          codeSnippet: "MOCK = 456",
        },
      ];

      mocks.scanPullRequest.mockResolvedValueOnce(findings).mockResolvedValueOnce([]);
      mocks.listComments.mockResolvedValue({ data: [] });
      mocks.createComment.mockResolvedValue({ data: { id: 102 } });

      const result = await processScanJob(jobData, undefined, {
        report: true,
        persist: false,
        enrich: false,
      });

      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      const commentBody = mocks.createComment.mock.calls[0][0].body;

      // Overall count reports total detected
      expect(commentBody).toContain("Detected **2** potential issues");

      // Comment mentions hidden count and threshold
      expect(commentBody).toContain("1 lower-confidence finding");
      expect(commentBody).toContain("below the `HIGH` confidence threshold was hidden");

      // Visible findings list includes HIGH finding, but NOT LOW finding
      expect(commentBody).toContain("High confidence production leak");
      expect(commentBody).toContain("`src/prod.ts`");
      expect(commentBody).toContain("**Confidence:** HIGH");
      expect(commentBody).not.toContain("Low confidence test mock");
      expect(commentBody).not.toContain("`tests/mock.ts`");

      // Result still contains all findings for dashboard visibility and persistence
      expect(result.findings).toHaveLength(2);
    });

    it("displays all findings when threshold is LOW", async () => {
      mocks.getContent.mockImplementation(({ path }: { path: string }) => {
        if (path === ".secureflow.json") {
          return Promise.resolve({
            data: {
              content: base64(
                JSON.stringify({
                  confidence: { minCommentConfidence: "LOW" },
                }),
              ),
            },
          });
        }
        return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
      });
      mocks.pullsGet.mockResolvedValue({ data: { base: { ref: "main" } } });

      const findings = [
        {
          type: "Secret",
          severity: "CRITICAL",
          confidence: "HIGH",
          fileLocation: "src/prod.ts",
          description: "High confidence issue",
          codeSnippet: "KEY = 123",
        },
        {
          type: "Vulnerability",
          severity: "LOW",
          confidence: "LOW",
          fileLocation: "tests/mock.ts",
          description: "Low confidence issue",
          codeSnippet: "MOCK = 456",
        },
      ];

      mocks.scanPullRequest.mockResolvedValueOnce(findings).mockResolvedValueOnce([]);
      mocks.listComments.mockResolvedValue({ data: [] });
      mocks.createComment.mockResolvedValue({ data: { id: 103 } });

      await processScanJob(jobData, undefined, {
        report: true,
        persist: false,
        enrich: false,
      });

      const commentBody = mocks.createComment.mock.calls[0][0].body;

      // No findings hidden
      expect(commentBody).not.toContain("lower-confidence finding");
      expect(commentBody).toContain("High confidence issue");
      expect(commentBody).toContain("`src/prod.ts`");
      expect(commentBody).toContain("Low confidence issue");
      expect(commentBody).toContain("`tests/mock.ts`");
    });
  });

  describe("deterministic workflow security checks (#2002)", () => {
    it("reports workflow rule findings in PR comment with correct severity, rule ID and one-line fix", async () => {
      const workflowFiles = [
        {
          filename: ".github/workflows/ci.yml",
          patch: `+name: CI\n+on:\n+  issues:\n+    types: [opened]\n+permissions:\n+  issues: read\n+jobs:\n+  test:\n+    runs-on: ubuntu-latest\n+    steps:\n+      - run: echo "\${{ github.event.issue.title }}"\n`,
        },
      ];

      mocks.listComments.mockResolvedValue({ data: [] });
      mocks.createComment.mockResolvedValue({ data: { id: 2002 } });
      mocks.scanPullRequest.mockResolvedValue([]);

      const result = await processScanJob(
        { ...jobData, fileChanges: workflowFiles } as ScanJobData,
        undefined,
        {
          report: true,
          persist: false,
          enrich: false,
        },
      );

      expect(result.findings.length).toBeGreaterThan(0);
      const scriptInjFinding = result.findings.find((f) =>
        f.matchedSignatures?.includes("WORKFLOW_SCRIPT_INJECTION"),
      );
      expect(scriptInjFinding).toBeDefined();
      expect(scriptInjFinding?.severity).toBe("HIGH");

      const commentBody = mocks.createComment.mock.calls[0][0].body;
      expect(commentBody).toContain("WORKFLOW_SCRIPT_INJECTION");
      expect(commentBody).toContain("`.github/workflows/ci.yml`");
      expect(commentBody).toContain("Fix:");
    });

    it("does not run workflow rules on files outside .github/workflows/", async () => {
      const otherFiles = [
        {
          filename: "scripts/deploy.yml",
          patch: `+name: Deploy\n+on: push\n+permissions: write-all\n+jobs:\n+  deploy:\n+    runs-on: ubuntu-latest\n+    steps:\n+      - uses: actions/checkout@v4\n`,
        },
      ];

      mocks.listComments.mockResolvedValue({ data: [] });
      mocks.createComment.mockResolvedValue({ data: { id: 2003 } });
      mocks.scanPullRequest.mockResolvedValue([]);

      const result = await processScanJob(
        { ...jobData, fileChanges: otherFiles } as ScanJobData,
        undefined,
        {
          report: true,
          persist: false,
          enrich: false,
        },
      );

      const workflowFindings = result.findings.filter((f) =>
        f.matchedSignatures?.some((s) => s.startsWith("WORKFLOW_")),
      );
      expect(workflowFindings.length).toBe(0);
    });
  });
});
