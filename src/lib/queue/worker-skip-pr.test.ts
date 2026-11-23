import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock functions
const mockPostScanSkippedCheckRun = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockRecordWebhookDelivery = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockLoadTrustedGateConfig = vi.hoisted(() => vi.fn());
const mockFetchPullRequestFiles = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ files: [], truncated: false, totalCount: 0 }),
);

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (this: any) {
    this.on = vi.fn();
  }),
  Queue: vi.fn().mockImplementation(function (this: any) {
    this.add = vi.fn();
  }),
  DelayedError: class DelayedError extends Error {},
}));

vi.mock("./redis", () => ({ redis: { set: vi.fn() } }));
vi.mock("./lock", () => ({
  acquireLock: vi.fn().mockResolvedValue("lock-token-123"),
  releaseLock: vi.fn().mockResolvedValue(true),
  startLockHeartbeat: vi.fn().mockReturnValue({
    stop: vi.fn(),
    isLost: vi.fn().mockReturnValue(false),
  }),
}));
vi.mock("./in-flight-scans", () => ({
  registerInFlightScan: vi.fn(),
  unregisterInFlightScan: vi.fn(),
}));

vi.mock("../scanner/check-run", () => ({
  postScanCheckRun: vi.fn().mockResolvedValue({}),
  postScanErrorCheckRun: vi.fn().mockResolvedValue({}),
  postScanCancelledCheckRun: vi.fn().mockResolvedValue({}),
  postScanSkippedCheckRun: mockPostScanSkippedCheckRun,
}));

vi.mock("@/lib/webhooks/delivery-recorder", () => ({
  recordWebhookDelivery: mockRecordWebhookDelivery,
  WEBHOOK_REASON_CODES: {
    DRAFT_PR: "DRAFT_PR",
    AUTHOR_SKIPPED: "AUTHOR_SKIPPED",
    REPO_DISABLED: "REPO_DISABLED",
    SCANNED: "SCANNED",
  },
}));

vi.mock("@/lib/scanner/gate-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scanner/gate-config")>(
    "@/lib/scanner/gate-config",
  );
  return {
    ...actual,
    loadTrustedGateConfig: mockLoadTrustedGateConfig,
  };
});

vi.mock("@/lib/github/pull-request-files", () => ({
  fetchPullRequestFiles: mockFetchPullRequestFiles,
  formatCoverageNotice: vi.fn(),
}));

vi.mock("@/lib/github/app-auth", () => ({
  getGitHubAppCredentials: vi.fn().mockReturnValue({
    appId: "123",
    privateKey: "dummy-key",
    Octokit: undefined,
  }),
  WebhookConfigurationError: class WebhookConfigurationError extends Error {},
}));

vi.mock("octokit", () => {
  return {
    App: class MockApp {
      getInstallationOctokit = vi.fn().mockResolvedValue({
        rest: {
          checks: {
            create: vi.fn().mockResolvedValue({ data: { id: 101 } }),
            update: vi.fn().mockResolvedValue({ data: { id: 101 } }),
          },
        },
      });
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: "repo-1", fullName: "owner/repo", isActive: true }),
      update: vi.fn().mockResolvedValue({ id: "repo-1", fullName: "owner/repo", isActive: true }),
    },
    pullRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: "pr-1", number: 101 }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    account: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/sbom/pull-request-manifests", () => ({
  handlePullRequestSynchronize: vi.fn().mockResolvedValue(undefined),
  shouldScanPullRequestManifests: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/github/sticky-comment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/sticky-comment")>();
  return {
    ...actual,
    upsertSecureFlowComment: vi.fn().mockResolvedValue({}),
  };
});

import { runPullRequestScan } from "./worker";
import { classifyPullRequestAction } from "@/lib/github/pull-request-facts";

describe("Draft PR and Bot Author skipping (#1982)", () => {
  const defaultJob: any = { id: "job-1", token: "tok-1" };
  const defaultRepo = {
    id: 1,
    full_name: "owner/repo",
    owner: { login: "owner" },
    name: "repo",
  };
  const defaultInstallation = { id: 42 };
  const defaultLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Draft PR Skipping", () => {
    it("skips draft PR early when skipDrafts is configured as true", async () => {
      mockLoadTrustedGateConfig.mockResolvedValueOnce({
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        skipDrafts: true,
      });

      const pullRequest = {
        id: 101,
        number: 101,
        draft: true,
        head: { sha: "head123" },
        base: { ref: "main" },
        user: { login: "developer-bob" },
      };

      const result = await runPullRequestScan({
        job: defaultJob,
        payload: { action: "opened", pull_request: pullRequest },
        pullRequest,
        repository: defaultRepo,
        installation: defaultInstallation,
        event: "pull_request",
        action: "opened",
        deliveryId: "del-draft-1",
        correlationId: "corr-1",
        log: defaultLog,
      });

      expect(mockPostScanSkippedCheckRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          owner: "owner",
          repo: "repo",
          headSha: "head123",
          reason: expect.stringContaining("skipDrafts is enabled"),
        }),
      );

      expect(mockRecordWebhookDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "del-draft-1",
          outcome: "ignored",
          reasonCode: "DRAFT_PR",
        }),
      );

      expect(mockFetchPullRequestFiles).not.toHaveBeenCalled();
      expect(result).toEqual({ dbRepoId: "repo-1" });
    });

    it("does not skip draft PR when skipDrafts is not configured (behaviour unchanged)", async () => {
      mockLoadTrustedGateConfig.mockResolvedValueOnce({
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        // skipDrafts undefined
      });

      const pullRequest = {
        id: 102,
        number: 102,
        draft: true,
        head: { sha: "head123" },
        base: { ref: "main" },
        user: { login: "developer-bob" },
      };

      await runPullRequestScan({
        job: defaultJob,
        payload: { action: "opened", pull_request: pullRequest },
        pullRequest,
        repository: defaultRepo,
        installation: defaultInstallation,
        event: "pull_request",
        action: "opened",
        deliveryId: "del-draft-2",
        correlationId: "corr-2",
        log: defaultLog,
      });

      expect(mockPostScanSkippedCheckRun).not.toHaveBeenCalled();
      expect(mockFetchPullRequestFiles).toHaveBeenCalled();
    });

    it("scans when draft PR is marked ready for review", async () => {
      expect(classifyPullRequestAction("ready_for_review")).toBe("scan");

      mockLoadTrustedGateConfig.mockResolvedValueOnce({
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        skipDrafts: true,
      });

      // When ready_for_review is delivered, draft is false
      const pullRequest = {
        id: 103,
        number: 103,
        draft: false,
        head: { sha: "head123" },
        base: { ref: "main" },
        user: { login: "developer-bob" },
      };

      await runPullRequestScan({
        job: defaultJob,
        payload: { action: "ready_for_review", pull_request: pullRequest },
        pullRequest,
        repository: defaultRepo,
        installation: defaultInstallation,
        event: "pull_request",
        action: "ready_for_review",
        deliveryId: "del-draft-3",
        correlationId: "corr-3",
        log: defaultLog,
      });

      expect(mockPostScanSkippedCheckRun).not.toHaveBeenCalled();
      expect(mockFetchPullRequestFiles).toHaveBeenCalled();
    });
  });

  describe("Bot Author Skipping", () => {
    it("skips scan for author matching skipAuthors exact login", async () => {
      mockLoadTrustedGateConfig.mockResolvedValueOnce({
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        skipAuthors: ["dependabot[bot]"],
      });

      const pullRequest = {
        id: 201,
        number: 201,
        draft: false,
        head: { sha: "head201" },
        base: { ref: "main" },
        user: { login: "dependabot[bot]" },
      };

      const result = await runPullRequestScan({
        job: defaultJob,
        payload: { action: "opened", pull_request: pullRequest },
        pullRequest,
        repository: defaultRepo,
        installation: defaultInstallation,
        event: "pull_request",
        action: "opened",
        deliveryId: "del-bot-1",
        correlationId: "corr-bot-1",
        log: defaultLog,
      });

      expect(mockPostScanSkippedCheckRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          reason: expect.stringContaining("Author @dependabot[bot] is excluded"),
        }),
      );

      expect(mockRecordWebhookDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "del-bot-1",
          outcome: "ignored",
          reasonCode: "AUTHOR_SKIPPED",
        }),
      );

      expect(mockFetchPullRequestFiles).not.toHaveBeenCalled();
      expect(result).toEqual({ dbRepoId: "repo-1" });
    });

    it("skips scan for author matching wildcard pattern (e.g. *bot*)", async () => {
      mockLoadTrustedGateConfig.mockResolvedValueOnce({
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        skipAuthors: ["*bot*"],
      });

      const pullRequest = {
        id: 202,
        number: 202,
        draft: false,
        head: { sha: "head202" },
        base: { ref: "main" },
        user: { login: "renovate-bot" },
      };

      await runPullRequestScan({
        job: defaultJob,
        payload: { action: "synchronize", pull_request: pullRequest },
        pullRequest,
        repository: defaultRepo,
        installation: defaultInstallation,
        event: "pull_request",
        action: "synchronize",
        deliveryId: "del-bot-2",
        correlationId: "corr-bot-2",
        log: defaultLog,
      });

      expect(mockPostScanSkippedCheckRun).toHaveBeenCalled();
      expect(mockRecordWebhookDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: "AUTHOR_SKIPPED",
        }),
      );
      expect(mockFetchPullRequestFiles).not.toHaveBeenCalled();
    });

    it("does not skip non-matching authors", async () => {
      mockLoadTrustedGateConfig.mockResolvedValueOnce({
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        skipAuthors: ["dependabot[bot]", "renovate[bot]"],
      });

      const pullRequest = {
        id: 203,
        number: 203,
        draft: false,
        head: { sha: "head203" },
        base: { ref: "main" },
        user: { login: "alice-engineer" },
      };

      await runPullRequestScan({
        job: defaultJob,
        payload: { action: "opened", pull_request: pullRequest },
        pullRequest,
        repository: defaultRepo,
        installation: defaultInstallation,
        event: "pull_request",
        action: "opened",
        deliveryId: "del-human-1",
        correlationId: "corr-human-1",
        log: defaultLog,
      });

      expect(mockPostScanSkippedCheckRun).not.toHaveBeenCalled();
      expect(mockFetchPullRequestFiles).toHaveBeenCalled();
    });
  });
});
