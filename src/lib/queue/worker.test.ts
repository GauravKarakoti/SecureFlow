import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mocks (must be hoisted before imports) ----
const handlers = vi.hoisted(() => ({
  completed: null as ((...args: any[]) => any) | null,
  failed: null as ((...args: any[]) => any) | null,
  error: null as ((...args: any[]) => any) | null,
}));

// Trap the handlers in our hoisted object so they survive Vitest clearing mocks
const mockWorkerOn = vi.hoisted(() =>
  vi.fn((event: string, handler: (...args: any[]) => any) => {
    if (event === "completed") handlers.completed = handler;
    if (event === "failed") handlers.failed = handler;
    if (event === "error") handlers.error = handler;
  }),
);

const mockDLQAdd = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());

vi.mock("bullmq", () => {
  return {
    Worker: vi.fn().mockImplementation(function (this: any) {
      this.on = mockWorkerOn;
    }),
    Queue: vi.fn().mockImplementation(function (this: any) {
      this.add = mockDLQAdd;
    }),
    DelayedError: class DelayedError extends Error {},
  };
});

const mockRepositoryUpdate = vi.hoisted(() => vi.fn());
const mockUploadSarifAnalysis = vi.hoisted(() => vi.fn());
const mockBuildSarifDocument = vi.hoisted(() => vi.fn(() => ({ runs: [] })));
const mockPullRequestRef = vi.hoisted(() => vi.fn((num: number) => `refs/pull/${num}/merge`));

vi.mock("./redis", () => ({ redis: { set: mockRedisSet } }));
vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      update: mockRepositoryUpdate,
    },
  },
}));
vi.mock("@/lib/github/code-scanning", () => ({
  uploadSarifAnalysis: mockUploadSarifAnalysis,
  buildSarifDocument: mockBuildSarifDocument,
  pullRequestRef: mockPullRequestRef,
}));
vi.mock("@/lib/armor/scanner", () => ({ scanner: {}, parseSecureFlowIgnore: vi.fn() }));
vi.mock("@/lib/sbom/pull-request-manifests", () => ({
  handlePullRequestSynchronize: vi.fn(),
}));
vi.mock("@/ai/flows/developer-receives-ai-security-explanations", () => ({
  developerReceivesAISecurityExplanations: vi.fn(),
}));

// ---- Imports (after mocks) ----
import {
  MAX_VALIDATION_ERROR_LENGTH,
  WebhookConfigurationError,
  assertPullRequestContext,
  getCommentableLines,
  getGitHubAppCredentials,
  payloadSchema,
  repositoryIdentity,
  selectRepositoryList,
  shouldScanPullRequestManifests,
  truncateForError,
  publishScanSarifAnalysis,
  runPullRequestScan,
  postScanFailureCheck,
} from "./worker";

describe("shouldScanPullRequestManifests", () => {
  it("runs the manifest (SBOM) scan for new commits on a pull request", () => {
    expect(shouldScanPullRequestManifests("pull_request", "synchronize")).toBe(true);
  });

  it("runs the manifest (SBOM) scan for check_run and check_suite rerequested (#1863)", () => {
    expect(shouldScanPullRequestManifests("check_run", "rerequested")).toBe(true);
    expect(shouldScanPullRequestManifests("check_suite", "rerequested")).toBe(true);
  });

  it.each([
    ["pull_request", "closed"],
    ["pull_request", "labeled"],
    ["pull_request", undefined],
    ["installation", "created"],
    ["branch_protection_rule", "edited"],
    ["merge_group", "checks_requested"],
    [null, "synchronize"],
  ])("skips %s / %s", (event, action) => {
    expect(shouldScanPullRequestManifests(event, action)).toBe(false);
  });
});

describe("Webhook Worker DLQ Routing", () => {
  beforeEach(() => {
    mockDLQAdd.mockClear();
  });

  it("registers completed, failed, and error listeners on the worker", () => {
    expect(handlers.completed).toBeTypeOf("function");
    expect(handlers.failed).toBeTypeOf("function");
    expect(handlers.error).toBeTypeOf("function");
  });

  it("logs worker connection errors without throwing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Redis connection lost");

    expect(() => handlers.error!(error)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("[QUEUE] Worker connection error:", error);
    errorSpy.mockRestore();
  });

  it("routes to DLQ when job fails permanently (attempts exhausted)", async () => {
    const failedHandler = handlers.failed!;

    const mockJob = {
      id: "job-failed-123",
      name: "process-webhook",
      data: { event: "pull_request", payload: { action: "opened" } },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };
    const mockError = new Error("Permanent fatal error");

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).toHaveBeenCalledWith(
      "process-webhook-dlq",
      expect.objectContaining({
        originalJobId: "job-failed-123",
        failedReason: "Permanent fatal error",
        attemptsMade: 3,
      }),
      { attempts: 1 },
    );
  });

  it("does NOT move to DLQ when job fails due to GitHub rate limits, but delays it instead (#2014)", async () => {
    const failedHandler = handlers.failed!;
    mockDLQAdd.mockClear();

    const mockJob = {
      id: "job-rate-limited-123",
      name: "process-webhook",
      data: { event: "pull_request", payload: { action: "synchronize" }, correlationId: "corr-1" },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };
    const rateLimitError = Object.assign(new Error("You have exceeded a secondary rate limit."), {
      status: 403,
      response: { headers: { "retry-after": "45" } },
    });

    await failedHandler(mockJob, rateLimitError);

    // Rate limit must NOT move job to DLQ (dlq adds "process-webhook-dlq")
    const dlqCalls = mockDLQAdd.mock.calls.filter((c: any[]) => c[0] === "process-webhook-dlq");
    expect(dlqCalls).toHaveLength(0);

    // Must requeue with delay ("process-webhook")
    expect(mockDLQAdd).toHaveBeenCalledWith(
      "process-webhook",
      mockJob.data,
      expect.objectContaining({
        delay: 45_000,
        priority: 2,
      }),
    );
  });

  it("writes the auto-retry count back onto the DLQ entry for a requeued job", async () => {
    const mockJob = {
      id: "delivery-abc",
      name: "process-webhook",
      data: { event: "pull_request", deliveryId: "abc", dlqAutoRetryCount: 2 },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    await handlers.failed!(mockJob, new Error("still failing"));

    const [, entry] = mockDLQAdd.mock.calls[0];
    expect(entry).toMatchObject({ autoRetryCount: 2, nextRetryAt: expect.any(String) });
  });

  it("leaves a first-time DLQ entry without auto-retry state", async () => {
    await handlers.failed!(
      {
        id: "job-1",
        name: "process-webhook",
        data: { event: "pull_request" },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error("boom"),
    );

    const [, entry] = mockDLQAdd.mock.calls[0];
    expect(entry).not.toHaveProperty("autoRetryCount");
    expect(entry).not.toHaveProperty("nextRetryAt");
  });

  it("does NOT route to DLQ when job fails temporarily (attempts remaining)", async () => {
    const failedHandler = handlers.failed!;

    const mockJob = {
      id: "job-retry-123",
      name: "process-webhook",
      data: { event: "pull_request", payload: { action: "opened" } },
      attemptsMade: 1,
      opts: { attempts: 3 },
    };
    const mockError = new Error("Temporary API error");

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).not.toHaveBeenCalled();
  });

  it("uses default maxAttempts of 3 when job.opts.attempts is missing (retry on attempt 2)", async () => {
    const failedHandler = handlers.failed!;

    const mockJob = {
      id: "job-no-opts-retry",
      name: "process-webhook",
      data: { event: "pull_request", payload: { action: "opened" } },
      attemptsMade: 2,
      opts: {},
    };
    const mockError = new Error("Database connection timeout");

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).not.toHaveBeenCalled();
  });

  it("uses default maxAttempts of 3 when job.opts.attempts is missing (DLQ on attempt 3)", async () => {
    const failedHandler = handlers.failed!;

    const mockJob = {
      id: "job-no-opts-dlq",
      name: "process-webhook",
      data: { event: "pull_request", payload: { action: "opened" } },
      attemptsMade: 3,
      opts: {},
    };
    const mockError = new Error("Database connection timeout");

    await failedHandler(mockJob, mockError);

    expect(mockDLQAdd).toHaveBeenCalledWith(
      "process-webhook-dlq",
      expect.objectContaining({
        originalJobId: "job-no-opts-dlq",
        failedReason: "Database connection timeout",
        attemptsMade: 3,
      }),
      { attempts: 1 },
    );
  });
});

describe("getCommentableLines (diff-position guard)", () => {
  it("returns added and context lines from a single hunk, excluding removed lines", () => {
    const patch = [
      "@@ -10,3 +10,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
    ].join("\n");
    const lines = getCommentableLines(patch);
    expect([...lines].sort((x, y) => x - y)).toEqual([10, 11, 12]);
  });

  it("handles multiple hunks and only-added lines", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " line one",
      "+new line two",
      " line three",
      "@@ -20,0 +21,2 @@",
      "+added twentyone",
      "+added twentytwo",
    ].join("\n");
    const lines = getCommentableLines(patch);

    expect(lines.has(2)).toBe(true); // added line in first hunk
    expect(lines.has(21)).toBe(true); // added line in second hunk
    expect(lines.has(22)).toBe(true);
    expect(lines.has(20)).toBe(false); // never present on the new side
  });

  it("returns an empty set for a patch with only removed lines", () => {
    const patch = ["@@ -5,2 +5,0 @@", "-gone one", "-gone two"].join("\n");
    expect(getCommentableLines(patch).size).toBe(0);
  });
});

describe("repositoryIdentity", () => {
  it("takes the current name and owner from the delivery", () => {
    // A rename or transfer keeps the numeric id, so the row is found by githubId
    // and must pick up the new name rather than keep the one it was created with.
    expect(
      repositoryIdentity({ full_name: "new-org/renamed", owner: { login: "new-org" } }),
    ).toEqual({ fullName: "new-org/renamed", owner: "new-org" });
  });

  it("falls back to the owner segment of full_name when owner.login is missing", () => {
    expect(repositoryIdentity({ full_name: "acme/api" })).toEqual({
      fullName: "acme/api",
      owner: "acme",
    });
    expect(repositoryIdentity({ full_name: "acme/api", owner: { login: "" } }).owner).toBe("acme");
    expect(repositoryIdentity({ full_name: "acme/api", owner: "not-an-object" }).owner).toBe(
      "acme",
    );
  });

  it("never includes userId", () => {
    expect(Object.keys(repositoryIdentity({ full_name: "acme/api" }))).toEqual([
      "fullName",
      "owner",
    ]);
  });
});

describe("selectRepositoryList", () => {
  const repo = (id: number, fullName: string) => ({ id, full_name: fullName });

  it("reads `repositories` for an installation/created delivery", () => {
    const result = selectRepositoryList("installation", "created", {
      repositories: [repo(1, "acme/api")],
    });

    expect(result.intent).toBe("add");
    expect(result.repositories).toHaveLength(1);
  });

  it("returns an empty list when installation/created omits `repositories`", () => {
    const result = selectRepositoryList("installation", "created", {});

    expect(result.intent).toBe("add");
    expect(result.repositories).toEqual([]);
  });

  it("reads `repositories_added` for installation_repositories/added", () => {
    const result = selectRepositoryList("installation_repositories", "added", {
      repositories_added: [repo(2, "acme/web")],
    });

    expect(result.intent).toBe("add");
    expect(result.repositories[0].full_name).toBe("acme/web");
  });

  it("reads `repositories_removed` for installation_repositories/removed", () => {
    const result = selectRepositoryList("installation_repositories", "removed", {
      repositories_removed: [repo(3, "acme/old")],
    });

    expect(result.intent).toBe("remove");
    expect(result.repositories[0].full_name).toBe("acme/old");
  });

  it("does not fall back to `repositories_added` on a removed delivery", () => {
    const result = selectRepositoryList("installation_repositories", "removed", {
      repositories_added: [repo(4, "acme/wrong")],
    });

    expect(result.repositories).toEqual([]);
  });

  it("ignores unrelated events and actions", () => {
    expect(selectRepositoryList("pull_request", "opened", {}).intent).toBe("ignore");
    expect(selectRepositoryList("installation_repositories", "weird", {}).intent).toBe("ignore");
  });

  it("deactivates an uninstalled or suspended installation's repositories", () => {
    // Ignored before, so uninstalling the App left every repository active.
    for (const action of ["deleted", "suspend"]) {
      const result = selectRepositoryList("installation", action, {
        repositories: [repo(5, "acme/api"), repo(6, "acme/web")],
      });
      expect(result.intent).toBe("remove");
      expect(result.repositories.map((r) => r.full_name)).toEqual(["acme/api", "acme/web"]);
    }
  });

  it("reactivates an unsuspended installation's repositories", () => {
    const result = selectRepositoryList("installation", "unsuspend", {
      repositories: [repo(5, "acme/api")],
    });
    expect(result.intent).toBe("add");
    expect(result.repositories).toHaveLength(1);
  });

  it("ignores installation actions that do not change repository access", () => {
    expect(selectRepositoryList("installation", "new_permissions_accepted", {}).intent).toBe(
      "ignore",
    );
  });

  it("drops malformed entries rather than passing them to BigInt()", () => {
    const result = selectRepositoryList("installation", "created", {
      repositories: [repo(1, "acme/api"), { nope: true }, null, "string"],
    });

    expect(result.repositories).toHaveLength(1);
  });

  it("returns an empty list when the field is not an array", () => {
    expect(
      selectRepositoryList("installation", "created", { repositories: "oops" }).repositories,
    ).toEqual([]);
  });
});

describe("assertPullRequestContext", () => {
  const validPayload = () => ({
    pull_request: { number: 12, head: { sha: "abc123" } },
    repository: { name: "api", full_name: "acme/api", owner: { login: "acme" } },
  });

  it("returns the resolved context for a complete payload", () => {
    const ctx = assertPullRequestContext(validPayload());

    expect(ctx.ownerLogin).toBe("acme");
    expect(ctx.repoName).toBe("api");
    expect(ctx.headSha).toBe("abc123");
    expect(ctx.prNumber).toBe(12);
  });

  it("derives owner and name from full_name when they are absent", () => {
    const ctx = assertPullRequestContext({
      pull_request: { number: 1, head: { sha: "deadbeef" } },
      repository: { full_name: "acme/api" },
    });

    expect(ctx.ownerLogin).toBe("acme");
    expect(ctx.repoName).toBe("api");
  });

  it("throws when pull_request is missing", () => {
    expect(() => assertPullRequestContext({ repository: { full_name: "a/b" } })).toThrow(
      /pull_request/,
    );
  });

  it("throws when repository is missing", () => {
    expect(() =>
      assertPullRequestContext({ pull_request: { number: 1, head: { sha: "x" } } }),
    ).toThrow(/repository/);
  });

  it("throws when head.sha is missing", () => {
    const payload = validPayload();
    delete (payload.pull_request as any).head;

    expect(() => assertPullRequestContext(payload)).toThrow(/head\.sha/);
  });

  it("throws when the PR number is not a number", () => {
    const payload = validPayload();
    (payload.pull_request as any).number = "12";

    expect(() => assertPullRequestContext(payload)).toThrow(/pull_request\.number/);
  });

  it("names every missing field at once", () => {
    let message = "";
    try {
      assertPullRequestContext({});
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("pull_request");
    expect(message).toContain("repository");
    expect(message).toContain("pull_request.head.sha");
  });
});

describe("getGitHubAppCredentials", () => {
  it("returns both credentials when configured", () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "line1\\nline2",
    });

    expect(creds.appId).toBe("12345");
    expect(creds.privateKey).toBe("line1\nline2");
  });

  it("leaves a key that already contains real newlines untouched", () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "line1\nline2",
    });

    expect(creds.privateKey).toBe("line1\nline2");
  });

  it("names GITHUB_APP_ID when it is missing", () => {
    expect(() => getGitHubAppCredentials({ GITHUB_PRIVATE_KEY: "k" })).toThrow(/GITHUB_APP_ID/);
  });

  it("names GITHUB_PRIVATE_KEY when it is missing", () => {
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: "1" })).toThrow(/GITHUB_PRIVATE_KEY/);
  });

  it("treats a blank value as missing", () => {
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: "  ", GITHUB_PRIVATE_KEY: "k" })).toThrow(
      /GITHUB_APP_ID/,
    );
    expect(() =>
      getGitHubAppCredentials({ GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "   " }),
    ).toThrow(/GITHUB_PRIVATE_KEY/);
  });

  it("throws WebhookConfigurationError, not a bare Error", () => {
    expect(() => getGitHubAppCredentials({})).toThrow(WebhookConfigurationError);
  });
});

describe("truncateForError", () => {
  it("leaves a short message alone", () => {
    expect(truncateForError("short")).toBe("short");
  });

  it("truncates and reports the original length", () => {
    const long = "x".repeat(MAX_VALIDATION_ERROR_LENGTH + 250);
    const result = truncateForError(long);

    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain(`${long.length} chars total`);
  });

  it("honours an explicit maximum", () => {
    expect(truncateForError("abcdefghij", 4)).toMatch(/^abcd…/);
  });

  it("does not truncate at exactly the limit", () => {
    const exact = "y".repeat(MAX_VALIDATION_ERROR_LENGTH);
    expect(truncateForError(exact)).toBe(exact);
  });
});

describe("publishScanSarifAnalysis", () => {
  const fakeOctokit = {} as any;
  const fakeRepository = {
    full_name: "acme/repo-one",
    name: "repo-one",
    owner: { login: "acme" },
  };
  const fakePullRequest = {
    number: 42,
    head: { sha: "abc12345" },
  };
  const fakeFindings = [
    {
      type: "HARDCODED_SECRET",
      severity: "CRITICAL",
      fileLocation: "index.ts",
      lineStart: 10,
      description: "Secret token leaked",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips SARIF upload when codeScanningEnabled is false or dbRepo is null", async () => {
    const resDisabled = await publishScanSarifAnalysis({
      octokit: fakeOctokit,
      repository: fakeRepository,
      pullRequest: fakePullRequest,
      findings: fakeFindings,
      dbRepo: { id: "repo-1", codeScanningEnabled: false },
    });

    expect(resDisabled).toEqual({ status: "skipped", reason: "code-scanning-disabled" });
    expect(mockUploadSarifAnalysis).not.toHaveBeenCalled();
    expect(mockRepositoryUpdate).not.toHaveBeenCalled();

    const resNull = await publishScanSarifAnalysis({
      octokit: fakeOctokit,
      repository: fakeRepository,
      pullRequest: fakePullRequest,
      findings: fakeFindings,
      dbRepo: null,
    });

    expect(resNull).toEqual({ status: "skipped", reason: "code-scanning-disabled" });
    expect(mockUploadSarifAnalysis).not.toHaveBeenCalled();
  });

  it("uploads SARIF analysis when codeScanningEnabled is true and clears prior warning", async () => {
    mockUploadSarifAnalysis.mockResolvedValueOnce({
      status: "uploaded",
      sarifId: "analysis-999",
    });

    const res = await publishScanSarifAnalysis({
      octokit: fakeOctokit,
      repository: fakeRepository,
      pullRequest: fakePullRequest,
      findings: fakeFindings,
      dbRepo: {
        id: "repo-1",
        codeScanningEnabled: true,
        codeScanningWarning: "Prior permission error",
      },
    });

    expect(res).toEqual({ status: "uploaded" });
    expect(mockUploadSarifAnalysis).toHaveBeenCalledWith(
      fakeOctokit,
      expect.objectContaining({
        owner: "acme",
        repo: "repo-one",
        commitSha: "abc12345",
        ref: "refs/pull/42/merge",
      }),
    );
    expect(mockRepositoryUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { codeScanningWarning: null },
    });
  });

  it("uploads SARIF analysis without updating DB when no warning was present", async () => {
    mockUploadSarifAnalysis.mockResolvedValueOnce({
      status: "uploaded",
      sarifId: "analysis-999",
    });

    const res = await publishScanSarifAnalysis({
      octokit: fakeOctokit,
      repository: fakeRepository,
      pullRequest: fakePullRequest,
      findings: fakeFindings,
      dbRepo: {
        id: "repo-1",
        codeScanningEnabled: true,
        codeScanningWarning: null,
      },
    });

    expect(res).toEqual({ status: "uploaded" });
    expect(mockUploadSarifAnalysis).toHaveBeenCalledTimes(1);
    expect(mockRepositoryUpdate).not.toHaveBeenCalled();
  });

  it("records warning on repository when code-scanning-unavailable occurs (403/404)", async () => {
    mockUploadSarifAnalysis.mockResolvedValueOnce({
      status: "skipped",
      reason: "code-scanning-unavailable",
    });

    const res = await publishScanSarifAnalysis({
      octokit: fakeOctokit,
      repository: fakeRepository,
      pullRequest: fakePullRequest,
      findings: fakeFindings,
      dbRepo: {
        id: "repo-1",
        codeScanningEnabled: true,
      },
    });

    expect(res).toEqual({ status: "skipped", reason: "code-scanning-unavailable" });
    expect(mockRepositoryUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: {
        codeScanningWarning:
          "GitHub App lacks security_events: write permission (Code scanning alerts: Read & Write) or Advanced Security is disabled on this repository.",
      },
    });
  });

  it("handles unexpected upload failure gracefully without throwing", async () => {
    mockUploadSarifAnalysis.mockRejectedValueOnce(new Error("GitHub API timed out"));

    const res = await publishScanSarifAnalysis({
      octokit: fakeOctokit,
      repository: fakeRepository,
      pullRequest: fakePullRequest,
      findings: fakeFindings,
      dbRepo: {
        id: "repo-1",
        codeScanningEnabled: true,
      },
    });

    expect(res).toEqual({ status: "error", error: "GitHub API timed out" });
  });
});

describe("payloadSchema (merge_group) (#1864)", () => {
  it("accepts a valid merge_group payload", () => {
    const payload = {
      action: "checks_requested",
      merge_group: {
        head_sha: "head-sha-123",
        head_ref: "refs/heads/gh-readonly-queue/main/pr-42-abc",
        base_sha: "base-sha-456",
        base_ref: "refs/heads/main",
        head_commit: {
          id: "head-sha-123",
          message: "Merge pull request #42 from acme/patch-1",
        },
      },
      repository: {
        id: 12345,
        name: "repo",
        full_name: "acme/repo",
      },
      installation: { id: 9999 },
    };

    const parsed = payloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.merge_group?.head_sha).toBe("head-sha-123");
    }
  });

  it("fails validation when merge_group is missing head_sha", () => {
    const payload = {
      action: "checks_requested",
      merge_group: {
        base_sha: "base-sha-456",
      },
    };

    const parsed = payloadSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});

describe("postScanFailureCheck (merge_group) (#1864)", () => {
  it("ignores non-checks_requested merge_group actions", async () => {
    await expect(
      postScanFailureCheck({
        event: "merge_group",
        payload: {
          action: "destroyed",
          installation: { id: 1 },
          merge_group: { head_sha: "sha-1" },
        },
      }),
    ).resolves.not.toThrow();
  });

  it("ignores merge_group without installation id", async () => {
    await expect(
      postScanFailureCheck({
        event: "merge_group",
        payload: {
          action: "checks_requested",
          merge_group: { head_sha: "sha-1" },
        },
      }),
    ).resolves.not.toThrow();
  });
});

describe("postScanFailureCheck (#1863)", () => {
  it("ignores undefined data or untracked events", async () => {
    await expect(postScanFailureCheck(undefined)).resolves.toBeUndefined();
    await expect(
      postScanFailureCheck({ event: "push", payload: {}, deliveryId: "d1" } as any),
    ).resolves.toBeUndefined();
  });

  it("ignores check_run with non-rerequested action", async () => {
    await expect(
      postScanFailureCheck({
        event: "check_run",
        payload: { action: "completed", check_run: { id: 123 } },
        deliveryId: "d1",
      } as any),
    ).resolves.toBeUndefined();
  });

  it("ignores check_suite with non-rerequested action", async () => {
    await expect(
      postScanFailureCheck({
        event: "check_suite",
        payload: { action: "completed", check_suite: { id: 123 } },
        deliveryId: "d1",
      } as any),
    ).resolves.toBeUndefined();
  });
});

describe("runPullRequestScan deduplication & concurrent locking (#1863)", () => {
  it("delays the job when PR is locked by a concurrent scan", async () => {
    const mockJob = {
      id: "job-1",
      token: "token-1",
      moveToDelayed: vi.fn().mockResolvedValue(undefined),
    };

    // When acquireLock fails (returns null) because another scan holds the lock
    mockRedisSet.mockResolvedValueOnce(null);

    await expect(
      runPullRequestScan({
        job: mockJob as any,
        payload: { action: "rerequested" },
        pullRequest: { id: 1, number: 10, head: { sha: "abc" } },
        repository: { id: 2, full_name: "org/repo", owner: { login: "org" }, name: "repo" },
        installation: { id: 3 },
        event: "check_run",
        action: "rerequested",
        deliveryId: "del-1",
        correlationId: "corr-1",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        isRerun: true,
        checkRunId: 1001,
      }),
    ).rejects.toThrow();

    expect(mockJob.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "token-1");
  });
});
