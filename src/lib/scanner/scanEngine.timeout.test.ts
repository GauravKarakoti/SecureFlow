import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  scanResultCreate: vi.fn(),
  autoResolveFixedFindings: vi.fn(),
}));

vi.mock("@/lib/armor/scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/armor/scanner")>();
  return {
    ...actual,
    scanner: {
      scanPullRequest: mocks.scanPullRequest,
      lastSkippedFiles: [],
      lastAnalyzedFiles: undefined,
    },
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
  default: {
    findingTriage: { findMany: vi.fn().mockResolvedValue([]) },
    scanResult: {
      create: mocks.scanResultCreate,
    },
    pullRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: "pr-1" }),
      upsert: vi.fn().mockResolvedValue({ id: "pr-1" }),
    },
    repository: {
      findFirst: vi.fn().mockResolvedValue({ id: "repo-1", userId: "user-1" }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/findings/auto-resolve", () => ({
  autoResolveFixedFindings: mocks.autoResolveFixedFindings,
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

import { processScanJob } from "./scanEngine";
import { ScannerTimeoutError } from "@/lib/armor/scanner";
import type { ScanJobData } from "@/lib/queue/scanQueue";

describe("processScanJob timeout budget and partial results (#1981)", () => {
  // 12 files -> 2 chunks (10 files + 2 files)
  const fileChanges = Array.from({ length: 12 }, (_, i) => ({
    filename: `src/file-${i}.ts`,
    patch: `+const secret${i} = "value${i}";`,
  }));

  const baseJobData: ScanJobData = {
    scanJobId: "job-timeout-1",
    repositoryId: "repo-1",
    installationId: 42,
    repositoryFullName: "acme/api",
    prNumber: 7,
    headSha: "abc123",
    fileChanges,
    activePolicies: [],
    customIgnores: [],
    customPlaceholders: [],
  } as unknown as ScanJobData;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateScanJobProgress.mockResolvedValue(undefined);
    mocks.explain.mockResolvedValue({
      explanation: "explanation",
      remediationSuggestions: "remediation",
      promptInjectionSuspected: false,
    });
    mocks.scanResultCreate.mockResolvedValue({ id: "scan-result-1" });
    mocks.autoResolveFixedFindings.mockResolvedValue({ resolvedCount: 0 });
    mocks.checksCreate.mockResolvedValue({ data: { id: 101 } });
    mocks.getContent.mockRejectedValue(new Error("Not found")); // default gate config
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops starting new chunks when timeout budget is reached, preserves completed findings, and marks scan partial", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const chunk1Finding = {
      type: "Hardcoded Secret",
      severity: "HIGH" as const,
      description: "Found secret",
      fileLocation: "src/file-0.ts",
      codeSnippet: 'const secret0 = "value0";',
    };

    // First chunk simulates a slow scan taking 125 seconds (exceeding 120s budget)
    mocks.scanPullRequest.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(125_000);
      return [chunk1Finding];
    });

    const result = await processScanJob(baseJobData, undefined, {
      report: true,
      persist: true,
    });

    // Chunk 1 should have been executed, Chunk 2 skipped due to budget exceeded
    expect(mocks.scanPullRequest).toHaveBeenCalledTimes(1);

    // Completed findings from chunk 1 are preserved
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].fileLocation).toBe("src/file-0.ts");

    // Remaining 2 files from chunk 2 are in skippedFiles
    expect(result.skippedFiles).toHaveLength(2);
    expect(result.skippedFiles[0].filename).toBe("src/file-10.ts");
    expect(result.skippedFiles[0].reason).toContain("Scan time budget of 120s exceeded");
    expect(result.skippedFiles[1].filename).toBe("src/file-11.ts");

    expect(result.isPartial).toBe(true);
    expect(result.timedOut).toBe(true);

    // Check run is created with conclusion "neutral" and PARTIAL title
    expect(mocks.checksCreate).toHaveBeenCalledTimes(1);
    const checkRunPayload = mocks.checksCreate.mock.calls[0][0];
    expect(checkRunPayload.conclusion).toBe("neutral");
    expect(checkRunPayload.output.title).toContain("Policy Decision: PARTIAL");
    expect(checkRunPayload.output.summary).toContain("Partial Scan — Unscanned Files (2)");
    expect(checkRunPayload.output.summary).toContain(
      "`src/file-10.ts`: Scan time budget of 120s exceeded",
    );
    expect(checkRunPayload.output.summary).toContain(
      "`src/file-11.ts`: Scan time budget of 120s exceeded",
    );

    // Scan result saved in database with isPartialScan: true and skippedFiles
    expect(mocks.scanResultCreate).toHaveBeenCalledTimes(1);
    const scanResultData = mocks.scanResultCreate.mock.calls[0][0].data;
    expect(scanResultData.gateConfig.isPartialScan).toBe(true);
    expect(scanResultData.gateConfig.isPartial).toBe(true);
    expect(scanResultData.gateConfig.skippedFiles).toEqual(["src/file-10.ts", "src/file-11.ts"]);

    // autoResolveFixedFindings is called with isPartialScan: true
    expect(mocks.autoResolveFixedFindings).toHaveBeenCalledTimes(1);
    expect(mocks.autoResolveFixedFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        isPartialScan: true,
      }),
    );
  });

  it("handles ScannerTimeoutError in a chunk by converting to partial scan instead of failing", async () => {
    const chunk1Finding = {
      type: "Hardcoded Secret",
      severity: "MEDIUM" as const,
      description: "Found secret",
      fileLocation: "src/file-1.ts",
      codeSnippet: 'const secret1 = "value1";',
    };

    // First chunk succeeds, second chunk throws ScannerTimeoutError
    mocks.scanPullRequest
      .mockResolvedValueOnce([chunk1Finding])
      .mockRejectedValueOnce(new ScannerTimeoutError("LLM scan timed out after 60 seconds"));

    const result = await processScanJob(baseJobData, undefined, {
      report: true,
      persist: true,
    });

    // Both chunks were attempted
    expect(mocks.scanPullRequest).toHaveBeenCalledTimes(2);

    // Chunk 1 findings preserved
    expect(result.findings).toHaveLength(1);
    expect(result.isPartial).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.skippedFiles).toHaveLength(2);
    expect(result.skippedFiles[0].filename).toBe("src/file-10.ts");
    expect(result.skippedFiles[0].reason).toContain("Scan timeout budget of 120s exceeded");

    // Check run completed with neutral
    expect(mocks.checksCreate).toHaveBeenCalledTimes(1);
    expect(mocks.checksCreate.mock.calls[0][0].conclusion).toBe("neutral");
    expect(mocks.checksCreate.mock.calls[0][0].output.title).toContain("Policy Decision: PARTIAL");

    // autoResolveFixedFindings protected against resolving
    expect(mocks.autoResolveFixedFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        isPartialScan: true,
      }),
    );
  });

  it("behaves exactly as before when all chunks finish within budget", async () => {
    const chunk1Finding = {
      type: "Hardcoded Secret",
      severity: "CRITICAL" as const,
      description: "Critical secret",
      fileLocation: "src/file-0.ts",
      codeSnippet: 'const secret0 = "value0";',
    };

    mocks.scanPullRequest.mockResolvedValueOnce([chunk1Finding]).mockResolvedValueOnce([]);

    const result = await processScanJob(baseJobData, undefined, {
      report: true,
      persist: true,
    });

    expect(mocks.scanPullRequest).toHaveBeenCalledTimes(2);
    expect(result.findings).toHaveLength(1);
    expect(result.skippedFiles).toHaveLength(0);
    expect(result.isPartial).toBe(false);
    expect(result.timedOut).toBe(false);

    // Normal check run decision (BLOCKED because of CRITICAL finding)
    expect(mocks.checksCreate).toHaveBeenCalledTimes(1);
    const checkRun = mocks.checksCreate.mock.calls[0][0];
    expect(checkRun.conclusion).toBe("failure");
    expect(checkRun.output.title).toBe("Policy Decision: BLOCKED");

    // GateConfig in DB does not have partial flag
    const scanResultData = mocks.scanResultCreate.mock.calls[0][0].data;
    expect(scanResultData.gateConfig.isPartialScan).toBeUndefined();

    // autoResolveFixedFindings called with isPartialScan: false
    expect(mocks.autoResolveFixedFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        isPartialScan: false,
      }),
    );
  });
});
