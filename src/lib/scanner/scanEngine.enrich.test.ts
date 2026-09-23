import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scanPullRequest: vi.fn(),
  explain: vi.fn(),
}));

vi.mock("@/lib/armor/scanner", () => ({
  scanner: { scanPullRequest: mocks.scanPullRequest },
}));
vi.mock("@/lib/armor/iq", () => ({
  iq: { evaluateFindings: () => "REVIEW REQUIRED" },
}));
vi.mock("@/ai/flows/developer-receives-ai-security-explanations", () => ({
  developerReceivesAISecurityExplanations: mocks.explain,
}));
vi.mock("@/lib/queue/worker", () => ({
  getGitHubAppCredentials: () => ({ appId: "1", privateKey: "key" }),
}));
vi.mock("@/lib/queue/scanQueue", () => ({
  updateScanJobProgress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/prisma", () => ({
  default: { findingTriage: { findMany: vi.fn().mockResolvedValue([]) } },
}));
vi.mock("octokit", () => ({
  App: class {
    async getInstallationOctokit() {
      return { rest: {} };
    }
  },
}));

import { processScanJob } from "./scanEngine";
import type { ScanJobData } from "@/lib/queue/scanQueue";

const jobData = {
  scanJobId: "job-1",
  repositoryId: "",
  installationId: 42,
  repositoryFullName: "acme/api",
  prNumber: 7,
  headSha: "abc123",
  fileChanges: [{ filename: "src/db.ts", patch: "+db.query(sql + id);" }],
  activePolicies: [],
  customIgnores: [],
  customPlaceholders: [],
} as unknown as ScanJobData;

const finding = {
  type: "VULNERABILITY",
  severity: "HIGH",
  description: "SQL injection",
  fileLocation: "src/db.ts",
  codeSnippet: "db.query(sql + id);",
};

describe("processScanJob enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.scanPullRequest.mockResolvedValue([{ ...finding }]);
    mocks.explain.mockResolvedValue({
      explanation: "Concatenated SQL.",
      remediationSuggestions: "Use parameters.",
      promptInjectionSuspected: false,
    });
  });

  it("explains active findings by default", async () => {
    const result = await processScanJob(jobData, undefined, { report: false, persist: false });

    expect(mocks.explain).toHaveBeenCalledTimes(1);
    expect(result.findings[0]).toMatchObject({ explanation: "Concatenated SQL." });
  });

  it("makes no AI calls with enrich: false, and still returns the fingerprinted findings", async () => {
    const result = await processScanJob(jobData, undefined, {
      report: false,
      persist: false,
      enrich: false,
    });

    expect(mocks.explain).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject(finding);
    expect(result.findings[0].fingerprint).toEqual(expect.any(String));
    expect(result.policyDecision).toBe("REVIEW");
  });
});
