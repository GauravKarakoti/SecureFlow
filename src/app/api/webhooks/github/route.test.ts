import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ---- Mocks (factories must not reference outer variables — they are hoisted) ----

const {
  mockEnqueueSbomScan,
  mockPrismaRepo,
  mockPrismaPR,
  mockOctokitListFiles,
  mockOctokitGetContent,
} = vi.hoisted(() => ({
  mockEnqueueSbomScan: vi.fn(),
  mockPrismaRepo: { findUnique: vi.fn() },
  mockPrismaPR: { upsert: vi.fn() },
  mockOctokitListFiles: vi.fn(),
  mockOctokitGetContent: vi.fn(),
}));

vi.mock("@/lib/queue/sbomQueue", () => ({
  enqueueSbomScan: mockEnqueueSbomScan,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: mockPrismaRepo,
    pullRequest: mockPrismaPR,
  },
}));

vi.mock("octokit", () => {
  return {
    Octokit: class MockOctokit {
      // GitHub's page walk: request pages until one comes back short.
      paginate = {
        iterator: async function* (
          route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
          params: Record<string, unknown>,
        ) {
          const perPage = (params.per_page as number | undefined) ?? 30;
          for (let page = 1; ; page++) {
            const response = await route({ ...params, page });
            yield response;
            if (response.data.length < perPage) return;
          }
        },
      };
      rest = {
        pulls: {
          listFiles: mockOctokitListFiles,
        },
        repos: {
          getContent: mockOctokitGetContent,
        },
      };
    },
  };
});

vi.mock("@/lib/queue/webhookQueue", () => ({ addWebhookJob: vi.fn(async () => {}) }));

vi.mock("@/lib/middleware/error-handler", () => {
  const AppError = class AppError extends Error {
    statusCode: number;
    constructor(msg: string, code = 400) {
      super(msg);
      this.statusCode = code;
    }
  };
  return {
    withErrorHandler:
      (fn: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string };
          return {
            status: e.statusCode || 500,
            json: async () => ({ error: e.message }),
          };
        }
      },
    AppError,
  };
});

vi.mock("@/lib/middleware/rateLimit", () => ({
  withRateLimit: <T extends (...args: unknown[]) => unknown>(handler: T): T => handler,
}));

// ---- Imports (after mocks) ----

import * as webhookRoute from "@/app/api/webhooks/github/route";
const { POST, handlePullRequestSynchronize } = webhookRoute;
import { addWebhookJob } from "@/lib/queue/webhookQueue";

// ---- Helpers ----

const SECRET = "test-webhook-secret";

function sign(body: string) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeRequest(
  body: string,
  overrides: Record<string, string | null> = {},
  event = "pull_request",
) {
  const headers: Record<string, string | null> = {
    "x-hub-signature-256": sign(body),
    "x-github-event": event,
    "x-github-delivery": "delivery-" + Math.random().toString(36).slice(2),
    "content-type": "application/json",
    ...overrides,
  };
  const streamChunks = [body];
  let chunkIndex = 0;
  return {
    headers: {
      get: (k: string) => {
        const lower = k.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === lower) {
            return value;
          }
        }
        return null;
      },
      has: (k: string) => {
        const lower = k.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === lower && value !== null && value !== undefined) {
            return true;
          }
        }
        return false;
      },
    },
    text: vi.fn(async () => body),
    json: vi.fn(async () => JSON.parse(body)),
    body: {
      getReader: vi.fn(() => ({
        read: async () => {
          if (chunkIndex >= streamChunks.length) return { done: true, value: undefined };
          const chunk = new TextEncoder().encode(streamChunks[chunkIndex++]);
          return { done: false, value: chunk };
        },
        releaseLock: vi.fn(),
      })),
    },
  } as any;
}

const minimalPRPayload = JSON.stringify({
  action: "opened",
  pull_request: { id: 1, number: 1, head: { sha: "abc" }, user: { login: "dev" } },
  repository: { id: 42, full_name: "org/repo" },
  installation: { id: 99 },
  sender: { id: 7 },
});

// ---- Tests ----

describe("GitHub webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    delete process.env.GITHUB_WEBHOOK_MAX_BYTES;
  });

  describe("signature verification (x-hub-signature-256)", () => {
    it("processes a webhook when the signature is valid", async () => {
      const req = makeRequest(minimalPRPayload);
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ status: "queued" });
      expect(addWebhookJob).toHaveBeenCalledOnce();
      expect(req.json).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature header is omitted completely (null)", async () => {
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": null });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Missing or invalid x-hub-signature-256 header" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature header is empty string", async () => {
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": "" });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Missing or invalid x-hub-signature-256 header" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature header format is malformed (missing sha256= prefix)", async () => {
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": "0".repeat(64) });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Missing or invalid x-hub-signature-256 header" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature header uses an unsupported prefix (e.g. md5= or sha1=)", async () => {
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": "md5=1234567890abcdef" });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Missing or invalid x-hub-signature-256 header" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature header contains non-hex characters", async () => {
      const req = makeRequest(minimalPRPayload, {
        "x-hub-signature-256": "sha256=" + "z".repeat(64),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Missing or invalid x-hub-signature-256 header" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature header length is invalid", async () => {
      const tooShort = makeRequest(minimalPRPayload, { "x-hub-signature-256": "sha256=12345" });
      const resShort = await POST(tooShort);
      expect(resShort.status).toBe(401);
      expect(await resShort.json()).toEqual({
        error: "Missing or invalid x-hub-signature-256 header",
      });

      const tooLong = makeRequest(minimalPRPayload, {
        "x-hub-signature-256": "sha256=" + "a".repeat(65),
      });
      const resLong = await POST(tooLong);
      expect(resLong.status).toBe(401);
      expect(await resLong.json()).toEqual({
        error: "Missing or invalid x-hub-signature-256 header",
      });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature was computed with a different secret", async () => {
      const wrongSecretSignature =
        "sha256=" + createHmac("sha256", "wrong-secret").update(minimalPRPayload).digest("hex");
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": wrongSecretSignature });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid GitHub webhook signature" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when the signature HMAC digest does not match the payload", async () => {
      const wrongSignature = "sha256=" + "0".repeat(64);
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": wrongSignature });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid GitHub webhook signature" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when a valid signature is provided for a modified payload", async () => {
      const originalPayload = JSON.stringify({ action: "opened", pr: 1 });
      const validSig = sign(originalPayload);
      const tamperedPayload = JSON.stringify({ action: "opened", pr: 2 });

      const req = makeRequest(tamperedPayload, { "x-hub-signature-256": validSig });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid GitHub webhook signature" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 401 Unauthorized when payload has a single character difference", async () => {
      const validSig = sign(minimalPRPayload);
      const modifiedPayload = minimalPRPayload + " ";

      const req = makeRequest(modifiedPayload, { "x-hub-signature-256": validSig });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid GitHub webhook signature" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("verifies signature strictly before parsing payload (malformed JSON with bad signature fails as 401, not 400)", async () => {
      const malformedBody = "{invalid-json";
      const badSig = "sha256=" + "0".repeat(64);

      const req = makeRequest(malformedBody, { "x-hub-signature-256": badSig });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid GitHub webhook signature" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("verifies before dispatching on the event type (#562)", async () => {
      // The old route filtered on x-github-event first, so an unauthenticated
      // caller sending `x-github-event: push` got a 200 "Event not tracked" --
      // an oracle distinguishing "endpoint exists" from "signature rejected",
      // and a free unauthenticated 200 responder.
      const req = makeRequest(
        minimalPRPayload,
        { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
        "push",
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("reads raw text and never calls req.json() before or during signature verification", async () => {
      const req = makeRequest(minimalPRPayload);
      await POST(req);
      expect(req.body.getReader).toHaveBeenCalled();
      expect(req.text).not.toHaveBeenCalled();
      expect(req.json).not.toHaveBeenCalled();
    });

    it("falls back to req.text() when req.body stream is unavailable", async () => {
      const req = makeRequest(minimalPRPayload);
      delete req.body;
      await POST(req);
      expect(req.text).toHaveBeenCalled();
      expect(req.json).not.toHaveBeenCalled();
    });
  });

  describe("delivery identity (#562)", () => {
    it("returns 400 when x-github-delivery is missing", async () => {
      // The worker guards its idempotency check on this value being truthy, so
      // forwarding null silently disabled duplicate detection -- and with
      // attempts: 3, a late failure re-ran the whole scan on every retry.
      const req = makeRequest(minimalPRPayload, { "x-github-delivery": null });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Missing or invalid x-github-delivery header" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 400 for a delivery id containing characters that cannot be a job id", async () => {
      const req = makeRequest(minimalPRPayload, { "x-github-delivery": "abc/../../etc" });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("enqueues with a deterministic job id so a replay collapses in the queue", async () => {
      const req = makeRequest(minimalPRPayload, { "x-github-delivery": "delivery-xyz" });
      await POST(req);

      expect(addWebhookJob).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: "delivery-xyz", event: "pull_request" }),
        { jobId: "delivery-delivery-xyz" },
      );
    });
  });

  describe("payload parsing (#562)", () => {
    it("returns 400, not 500, for a verified body that is not valid JSON", async () => {
      // A bare SyntaxError carries no statusCode, so the error handler used to
      // return 500 -- which GitHub treats as retryable, re-delivering a payload
      // that can never succeed.
      const body = "{not json";
      const req = makeRequest(body, { "x-hub-signature-256": sign(body) });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 400 for valid JSON that is not an object", async () => {
      const body = "[]";
      const req = makeRequest(body, { "x-hub-signature-256": sign(body) });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("body size limit (#562)", () => {
    it("returns 413 from Content-Length before the body is read", async () => {
      process.env.GITHUB_WEBHOOK_MAX_BYTES = "16";
      let readCount = 0;
      const req = makeRequest(minimalPRPayload, { "content-length": "999999" });
      const original = req.text;
      req.text = async () => {
        readCount += 1;
        return original();
      };

      const res = await POST(req);

      expect(res.status).toBe(413);
      expect(readCount).toBe(0);
    });

    it("returns 413 when Content-Length lied about being small", async () => {
      // Content-Length is attacker-supplied, so the real byte length is
      // re-checked after reading.
      process.env.GITHUB_WEBHOOK_MAX_BYTES = "16";
      const req = makeRequest(minimalPRPayload, { "content-length": "1" });
      const res = await POST(req);
      expect(res.status).toBe(413);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("accepts a normal payload under the default cap", async () => {
      const req = makeRequest(minimalPRPayload);
      const res = await POST(req);
      expect(res.status).toBe(202);
    });

    it("returns 413 when Content-Length lied and req.body is unavailable", async () => {
      process.env.GITHUB_WEBHOOK_MAX_BYTES = "16";
      const req = makeRequest(minimalPRPayload, { "content-length": "1" });
      delete req.body;
      const res = await POST(req);
      expect(res.status).toBe(413);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });
  });

  describe("event dispatch", () => {
    it("returns 202 and queues the job for a valid pull_request event", async () => {
      const req = makeRequest(minimalPRPayload);
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledOnce();
    });

    it("returns 200 but does NOT queue for an untracked event type", async () => {
      const req = makeRequest(minimalPRPayload, {}, "push");
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("answers ping only after verifying the signature (#562)", async () => {
      // ping is GitHub's first delivery when a webhook is registered. Answering
      // it before verification meant a webhook configured with the wrong secret
      // still looked healthy in the GitHub UI.
      const req = makeRequest(minimalPRPayload, {}, "ping");
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "pong" });
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("rejects an unsigned ping", async () => {
      const req = makeRequest(
        minimalPRPayload,
        { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
        "ping",
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("returns 202 and queues installation events", async () => {
      const body = JSON.stringify({
        action: "created",
        installation: { id: 1 },
        sender: { id: 2 },
      });
      const req = makeRequest(body, {}, "installation");
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledOnce();
    });

    it("returns 202 and queues installation_repositories events", async () => {
      const body = JSON.stringify({
        action: "added",
        installation: { id: 1 },
        repositories_added: [],
        sender: { id: 2 },
      });
      const req = makeRequest(body, {}, "installation_repositories");
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledOnce();
    });

    it("returns 202 and queues pull_request synchronize events without synchronous processing", async () => {
      const spy = vi.spyOn(webhookRoute, "handlePullRequestSynchronize");
      const body = JSON.stringify({
        action: "synchronize",
        number: 42,
        pull_request: { id: 1, number: 42, head: { sha: "abcdef123456" } },
        repository: { id: 42, full_name: "org/repo" },
        installation: { id: 99 },
      });
      const req = makeRequest(body, { "x-github-delivery": "delivery-sync-42" }, "pull_request");
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ status: "queued", deliveryId: "delivery-sync-42" });
      expect(addWebhookJob).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "delivery-sync-42",
          event: "pull_request",
          payload: expect.objectContaining({ action: "synchronize" }),
        }),
        { jobId: "delivery-delivery-sync-42" },
      );
      // Ensure no duplicate synchronous execution occurs in the request handler
      expect(spy).not.toHaveBeenCalled();
    });

    it("returns 202 and queues branch_protection_rule events", async () => {
      const body = JSON.stringify({
        action: "created",
        rule: { name: "main" },
        repository: { full_name: "org/repo" },
      });
      const req = makeRequest(body, {}, "branch_protection_rule");
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledOnce();
    });

    it("passes the delivery ID and event type to the queue", async () => {
      const deliveryId = "unique-delivery-xyz";
      const req = makeRequest(minimalPRPayload, { "x-github-delivery": deliveryId });
      await POST(req);
      expect(addWebhookJob).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId, event: "pull_request" }),
        expect.objectContaining({ jobId: `delivery-${deliveryId}` }),
      );
    });

    it("ensures duplicate delivery IDs map to identical deterministic job IDs for idempotency", async () => {
      const deliveryId = "delivery-duplicate-test-abc123";
      const req1 = makeRequest(minimalPRPayload, { "x-github-delivery": deliveryId });
      const req2 = makeRequest(minimalPRPayload, { "x-github-delivery": deliveryId });

      const res1 = await POST(req1);
      const res2 = await POST(req2);

      expect(res1.status).toBe(202);
      expect(res2.status).toBe(202);
      expect(addWebhookJob).toHaveBeenCalledTimes(2);
      expect(addWebhookJob).toHaveBeenNthCalledWith(1, expect.objectContaining({ deliveryId }), {
        jobId: `delivery-${deliveryId}`,
      });
      expect(addWebhookJob).toHaveBeenNthCalledWith(2, expect.objectContaining({ deliveryId }), {
        jobId: `delivery-${deliveryId}`,
      });
    });
  });

  describe("deployment faults", () => {
    it("returns 500 when GITHUB_WEBHOOK_SECRET is not configured", async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const req = makeRequest(minimalPRPayload);
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("does not allow unsigned requests when GITHUB_WEBHOOK_SECRET is unset", async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": null });
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 500 when GITHUB_WEBHOOK_SECRET is empty string, rejecting unsigned requests", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "";
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": null });
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });

    it("returns 500 when GITHUB_WEBHOOK_SECRET is whitespace-only, rejecting unsigned and forged requests", async () => {
      process.env.GITHUB_WEBHOOK_SECRET = "   ";
      const req = makeRequest(minimalPRPayload, { "x-hub-signature-256": null });
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(addWebhookJob).not.toHaveBeenCalled();
    });
  });

  describe("handlePullRequestSynchronize — Webhook Ownership & Deduplication (Finding 1 & 6)", () => {
    const syncPayload = {
      action: "synchronize",
      number: 10,
      pull_request: {
        id: 999,
        number: 10,
        title: "Update deps",
        state: "open",
        head: { sha: "commit-sha-123", ref: "feature-branch" },
        user: { login: "developer-alice", avatar_url: "https://example.com/alice.png" },
      },
      repository: {
        id: 8888,
        name: "test-app",
        full_name: "acme/test-app",
        owner: { login: "acme" },
      },
      installation: { id: 777 },
    };

    beforeEach(() => {
      mockPrismaRepo.findUnique.mockResolvedValue({
        id: "repo-uuid-1",
        userId: "user-real-owner",
        fullName: "acme/test-app",
      });
      mockPrismaPR.upsert.mockResolvedValue({
        id: "pr-uuid-1",
      });
      mockOctokitListFiles.mockResolvedValue({
        data: [{ filename: "package.json" }],
      });
      mockOctokitGetContent.mockResolvedValue({
        data: {
          content: Buffer.from(JSON.stringify({ dependencies: { lodash: "4.17.20" } })).toString(
            "base64",
          ),
        },
      });
    });

    it("resolves repository and PR ownership correctly, passing real userId, repositoryId, and pullRequestId", async () => {
      await handlePullRequestSynchronize(syncPayload, "delivery-uuid-99");

      expect(mockPrismaRepo.findUnique).toHaveBeenCalledWith({
        where: { githubId: BigInt(8888) },
      });

      expect(mockPrismaPR.upsert).toHaveBeenCalledWith({
        where: { githubId: BigInt(999) },
        update: expect.objectContaining({
          title: "Update deps",
          state: "OPEN",
        }),
        create: expect.objectContaining({
          githubId: BigInt(999),
          prNumber: 10,
          title: "Update deps",
          state: "OPEN",
          status: "REVIEW_REQUIRED",
          authorLogin: "developer-alice",
          authorAvatarUrl: "https://example.com/alice.png",
          repositoryId: "repo-uuid-1",
        }),
      });

      expect(mockEnqueueSbomScan).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: "package.json",
          userId: "user-real-owner",
          repositoryId: "repo-uuid-1",
          pullRequestId: "pr-uuid-1",
        }),
        expect.objectContaining({
          dedupeKey: "webhook:repo-uuid-1:pr-uuid-1:commit-sha-123:package.json",
          jobId: "sbom-repo-uuid-1-pr-uuid-1-commit-sha-123-package_json",
          deliveryId: "delivery-uuid-99",
        }),
      );

      // Verify no empty string or fake userId is sent
      const callData = mockEnqueueSbomScan.mock.calls[0][0];
      expect(callData.userId).not.toBe("");
      expect(callData.userId).toBe("user-real-owner");
    });

    it("finds a manifest past the first page of changed files", async () => {
      // 45 changed files, the manifest last. GitHub pages this endpoint 30 at a
      // time unless asked for more, and a request without `page` is page 1.
      const changed = [
        ...Array.from({ length: 44 }, (_, i) => ({ filename: `src/file-${i}.ts` })),
        { filename: "package.json" },
      ];
      mockOctokitListFiles.mockImplementation(
        async ({ page = 1, per_page = 30 }: { page?: number; per_page?: number }) => ({
          data: changed.slice((page - 1) * per_page, page * per_page),
        }),
      );

      await handlePullRequestSynchronize(syncPayload, "delivery-uuid-99");

      expect(mockEnqueueSbomScan).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: "package.json" }),
        expect.anything(),
      );
    });

    it("skips SBOM enqueue when repository cannot be resolved in SecureFlow database", async () => {
      mockPrismaRepo.findUnique.mockResolvedValue(null);

      await handlePullRequestSynchronize(syncPayload, "delivery-uuid-99");

      expect(mockEnqueueSbomScan).not.toHaveBeenCalled();
      expect(mockPrismaPR.upsert).not.toHaveBeenCalled();
    });

    it("reads manifests at the PR's head commit, not by branch name on the base repository", async () => {
      // A pull request from a fork whose branch is also called `main`. The base
      // repository's `main` has an older manifest; the PR's commit has the new one.
      const forkPayload = {
        ...syncPayload,
        pull_request: {
          ...syncPayload.pull_request,
          head: {
            sha: "fork-head-sha",
            ref: "main",
            repo: { full_name: "contributor/test-app" },
          },
        },
      };
      const encode = (deps: Record<string, string>) => ({
        data: { content: Buffer.from(JSON.stringify({ dependencies: deps })).toString("base64") },
      });
      mockOctokitGetContent.mockImplementation(async ({ ref }: { ref: string }) =>
        ref === "fork-head-sha" ? encode({ lodash: "4.17.20" }) : encode({ lodash: "4.17.21" }),
      );

      await handlePullRequestSynchronize(forkPayload, "delivery-uuid-99");

      expect(mockOctokitGetContent).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "acme", repo: "test-app", ref: "fork-head-sha" }),
      );
      const { content } = mockEnqueueSbomScan.mock.calls[0][0];
      expect(JSON.parse(content).dependencies.lodash).toBe("4.17.20");
    });

    it("skips SBOM enqueue when repository has no owner (empty userId)", async () => {
      mockPrismaRepo.findUnique.mockResolvedValue({
        id: "repo-uuid-orphan",
        userId: "",
      });

      await handlePullRequestSynchronize(syncPayload, "delivery-uuid-99");

      expect(mockEnqueueSbomScan).not.toHaveBeenCalled();
    });

    it("uses a stable logical dedupe key across redeliveries of the same PR commit", async () => {
      await handlePullRequestSynchronize(syncPayload, "delivery-attempt-1");
      await handlePullRequestSynchronize(syncPayload, "delivery-attempt-2");

      expect(mockEnqueueSbomScan).toHaveBeenCalledTimes(2);

      const firstOptions = mockEnqueueSbomScan.mock.calls[0][1];
      const secondOptions = mockEnqueueSbomScan.mock.calls[1][1];

      // Delivery IDs differ
      expect(firstOptions.deliveryId).toBe("delivery-attempt-1");
      expect(secondOptions.deliveryId).toBe("delivery-attempt-2");

      // Stable logical dedupe keys and jobIds are identical
      expect(firstOptions.dedupeKey).toBe(secondOptions.dedupeKey);
      expect(firstOptions.jobId).toBe(secondOptions.jobId);
      expect(firstOptions.dedupeKey).toBe(
        "webhook:repo-uuid-1:pr-uuid-1:commit-sha-123:package.json",
      );
    });

    it("passes a job id without `:`, which BullMQ rejects as a custom id", async () => {
      await handlePullRequestSynchronize(syncPayload, "delivery-uuid-99");

      expect(mockEnqueueSbomScan.mock.calls[0][1].jobId).not.toContain(":");
    });
  });
});
