import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { authMock, findingFindFirst, github, armorClient, verifyIntentToken } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findingFindFirst: vi.fn(),
  verifyIntentToken: vi.fn(),
  armorClient: {
    capturePlan: vi.fn(),
    getIntentToken: vi.fn(),
  },
  github: {
    createBlob: vi.fn(),
    createTree: vi.fn(),
    createCommit: vi.fn(),
    createRef: vi.fn(),
    pullsCreate: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findFirst: findingFindFirst },
    remediationPatch: { update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({
  getGitHubAppCredentials: () => ({ appId: "1", privateKey: "key" }),
}));
vi.mock("@/lib/armor/auto-remediation", () => ({
  AUTO_REMEDIATION_ARMORIQ_SCOPE: { allow: ["fs.readwrite"], deny: ["github.push"] },
  isAllowedAutoRemediationPath: () => true,
  applyScopedUnifiedDiff: () => "updated source",
}));
vi.mock("@/lib/armor/iq", () => ({
  ArmorIQService: {
    getClient: () => armorClient,
    verifyIntentToken,
  },
}));
vi.mock("octokit", () => {
  const octokit = {
    rest: {
      repos: { get: async () => ({ data: { default_branch: "main" } }) },
      git: {
        getRef: async () => ({ data: { object: { sha: "commit-sha" } } }),
        getCommit: async () => ({ data: { tree: { sha: "root-tree" } } }),
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({
          data: {
            tree:
              tree_sha === "root-tree"
                ? [{ path: "src", type: "tree", mode: "040000", sha: "src-tree" }]
                : [{ path: "a.ts", type: "blob", mode: "100644", sha: "blob-sha" }],
          },
        }),
        getBlob: async () => ({ data: { content: "original source", encoding: "utf8" } }),
        createBlob: github.createBlob,
        createTree: github.createTree,
        createCommit: github.createCommit,
        createRef: github.createRef,
      },
      pulls: {
        create: github.pullsCreate,
        list: async () => ({ data: [] }),
      },
    },
  };
  return {
    App: class {
      octokit = { rest: { apps: { getRepoInstallation: async () => ({ data: { id: 7 } }) } } };
      getInstallationOctokit = async () => octokit;
    },
  };
});

import { resetModelCircuitBreakers } from "@/ai/resilience";
import { POST } from "./route";

const finding = {
  id: "finding-1",
  type: "VULNERABILITY",
  fileLocation: "src/a.ts",
  explanation: "unsafe call",
  remediationPatch: { patchDiff: "diff --git", status: "GENERATED" },
  scanResult: { pullRequest: { repository: { fullName: "owner/repo" } } },
};

const timeout = () =>
  Object.assign(new Error("ArmorIQ policy verification timed out"), {
    name: "ArmorIQTimeoutError",
    status: 504,
  });

function apply() {
  return POST(
    new NextRequest("http://localhost/api/findings/finding-1/remediate/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    }),
    { params: Promise.resolve({ id: "finding-1" }) },
  );
}

describe("POST /api/findings/[id]/remediate/apply with an unavailable ArmorIQ (#1376)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    findingFindFirst.mockResolvedValue(finding);
    armorClient.capturePlan.mockReturnValue({ captured: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetModelCircuitBreakers();
  });

  it("blocks remediation with 403 on a single ArmorIQ timeout and writes nothing to GitHub", async () => {
    armorClient.getIntentToken.mockRejectedValue(timeout());

    const response = await apply();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "ArmorIQ authorization failed; remediation is blocked",
    });
    expect(github.createBlob).not.toHaveBeenCalled();
    expect(github.pullsCreate).not.toHaveBeenCalled();
  });

  it("answers 202 and queues intent in DLQ without calling ArmorIQ once consecutive timeouts open the circuit (#1751)", async () => {
    armorClient.getIntentToken.mockRejectedValue(timeout());
    for (let i = 0; i < 3; i++) {
      expect((await apply()).status).toBe(403);
    }
    expect(armorClient.getIntentToken).toHaveBeenCalledTimes(3);

    const response = await apply();

    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data.status).toBe("queued");
    expect(data.queued).toBe(true);
    expect(typeof data.jobId).toBe("string");
    expect(data.jobId).toMatch(/^rem-dlq-/);
    expect(armorClient.getIntentToken).toHaveBeenCalledTimes(3);
    expect(github.createBlob).not.toHaveBeenCalled();
  });

  it("answers 202 when token verification reports ArmorIQ unavailable and queues intent (#1751)", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "h" });
    verifyIntentToken.mockResolvedValue({
      valid: false,
      unavailable: true,
      reason: "ArmorIQ is temporarily unavailable (circuit open)",
    });

    const response = await apply();

    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data.status).toBe("queued");
    expect(data.queued).toBe(true);
    expect(typeof data.jobId).toBe("string");
    expect(data.jobId).toMatch(/^rem-dlq-/);
    expect(github.createBlob).not.toHaveBeenCalled();
  });

  it("validates recovery: once circuit breaker resets, subsequent requests succeed and process remediation (#1751)", async () => {
    armorClient.getIntentToken.mockRejectedValue(timeout());
    for (let i = 0; i < 3; i++) {
      expect((await apply()).status).toBe(403);
    }
    // Breaker is open
    const trippedResponse = await apply();
    expect(trippedResponse.status).toBe(202);

    // Reset breaker (simulating recovery)
    resetModelCircuitBreakers();

    // Replay/apply under recovered condition
    armorClient.capturePlan.mockImplementation((_app: any, _desc: any, plan: any) => ({ plan }));
    armorClient.getIntentToken.mockImplementation((capture: any) => ({
      rawToken: { plan: capture.plan, token: { plan_hash: "valid-plan-hash" } },
      planHash: "valid-plan-hash",
    }));
    verifyIntentToken.mockResolvedValue({ valid: true, unavailable: false });
    github.createBlob.mockResolvedValue({ data: { sha: "blob-sha" } });
    github.createTree.mockResolvedValue({ data: { sha: "tree-sha" } });
    github.createCommit.mockResolvedValue({ data: { sha: "commit-sha" } });
    github.createRef.mockResolvedValue({ data: {} });
    github.pullsCreate.mockResolvedValue({
      data: { html_url: "https://github.com/owner/repo/pull/101" },
    });

    const recoveredResponse = await apply();
    expect(recoveredResponse.status).toBe(200);
    const result = await recoveredResponse.json();
    expect(result.success).toBe(true);
    expect(github.createBlob).toHaveBeenCalled();
    expect(github.pullsCreate).toHaveBeenCalled();
  });

  it("still answers 403 when ArmorIQ is reachable but rejects the token", async () => {
    armorClient.getIntentToken.mockResolvedValue({ rawToken: {}, planHash: "h" });
    verifyIntentToken.mockResolvedValue({ valid: false, reason: "Invalid token signing key" });

    const response = await apply();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "ArmorIQ intent verification failed; remediation is blocked",
    });
  });
});
