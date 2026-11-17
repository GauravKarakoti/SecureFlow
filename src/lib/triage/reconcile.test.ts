import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pullFindMany: vi.fn(),
  triageFindMany: vi.fn(),
  scanUpdate: vi.fn(),
  pullUpdate: vi.fn(),
  checksUpdate: vi.fn(),
  pullsGet: vi.fn(),
  checksList: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    pullRequest: { findMany: mocks.pullFindMany, update: mocks.pullUpdate },
    findingTriage: { findMany: mocks.triageFindMany },
    scanResult: { update: mocks.scanUpdate },
    $transaction: (updates: Promise<unknown>[]) => Promise.all(updates),
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  getGitHubAppCredentials: () => ({ appId: "123", privateKey: "test" }),
}));

vi.mock("octokit", () => ({
  App: class {
    octokit = { rest: { apps: { getRepoInstallation: async () => ({ data: { id: 7 } }) } } };
    async getInstallationOctokit() {
      return {
        rest: {
          pulls: { get: mocks.pullsGet },
          checks: { listForRef: mocks.checksList, update: mocks.checksUpdate },
        },
      };
    }
  },
}));

import { reconcileTriageVerdicts } from "./reconcile";

const high = {
  fingerprint: "same-finding",
  type: "VULNERABILITY",
  severity: "HIGH",
  fileLocation: "src/auth.ts",
  codeSnippet: "unsafe()",
  explanation: "Unsafe call",
  lineStart: 3,
  lineEnd: 3,
};

function affectedPr(headSha: string | null = "abc") {
  return {
    id: "pr-1",
    prNumber: 12,
    repository: { fullName: "owner/repo" },
    scans: [
      {
        id: "scan-1",
        headSha,
        gateConfig: { blockOn: "HIGH", reviewOn: "MEDIUM" },
        findings: [high],
      },
    ],
  };
}

describe("reconcileTriageVerdicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pullFindMany.mockResolvedValue([affectedPr()]);
    mocks.triageFindMany.mockResolvedValue([{ fingerprint: high.fingerprint }]);
    mocks.pullsGet.mockResolvedValue({ data: { state: "open", head: { sha: "abc" } } });
    mocks.checksList.mockResolvedValue({
      data: {
        check_runs: [
          { id: 99, name: "SecureFlow Scan", output: { title: "Policy Decision: BLOCKED" } },
        ],
      },
    });
    mocks.checksUpdate.mockResolvedValue({});
    mocks.scanUpdate.mockResolvedValue({});
    mocks.pullUpdate.mockResolvedValue({});
  });

  it("changes the matching scanned PR verdict and its existing GitHub check", async () => {
    expect(await reconcileTriageVerdicts("repo-1", [high.fingerprint])).toEqual({
      updated: 1,
      pending: 0,
    });
    expect(mocks.checksUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 99, conclusion: "success" }),
    );
    expect(mocks.scanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { policyDecision: "PASS", riskScore: 0 } }),
    );
    expect(mocks.pullUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PASS" } }),
    );
  });

  it("reopening the finding restores a blocking GitHub check and dashboard status", async () => {
    mocks.triageFindMany.mockResolvedValue([]);
    expect(await reconcileTriageVerdicts("repo-1", [high.fingerprint])).toEqual({
      updated: 1,
      pending: 0,
    });
    expect(mocks.checksUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 99, conclusion: "failure" }),
    );
    expect(mocks.pullUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "BLOCKED" } }),
    );
  });

  it("never certifies a newer unscanned PR head", async () => {
    mocks.pullsGet.mockResolvedValue({ data: { state: "open", head: { sha: "newer" } } });
    expect(await reconcileTriageVerdicts("repo-1", [high.fingerprint])).toEqual({
      updated: 0,
      pending: 1,
    });
    expect(mocks.checksUpdate).not.toHaveBeenCalled();
    expect(mocks.pullUpdate).not.toHaveBeenCalled();
  });

  it("requires a known scanned SHA for historical results", async () => {
    mocks.pullFindMany.mockResolvedValue([affectedPr(null)]);
    expect(await reconcileTriageVerdicts("repo-1", [high.fingerprint])).toEqual({
      updated: 0,
      pending: 1,
    });
    expect(mocks.checksUpdate).not.toHaveBeenCalled();
    expect(mocks.pullUpdate).not.toHaveBeenCalled();
  });
});
