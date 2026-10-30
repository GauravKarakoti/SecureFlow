/**
 * Integration tests for POST /api/webhooks/bitbucket (#1466).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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
          return new Response(JSON.stringify({ error: e.message }), {
            status: e.statusCode || 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    AppError,
  };
});

vi.mock("@/lib/middleware/rate-limit", () => ({
  withRateLimit: <T>(handler: T): T => handler,
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { POST } from "./route";

const BB_SECRET = "bitbucket-hmac-secret-key";

function makeSig(body: string, secret: string = BB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function makeBitbucketRequest(
  payload: Record<string, unknown>,
  eventKey: string,
  secret: string = BB_SECRET,
): Request {
  const body = JSON.stringify(payload);
  return new Request("http://localhost/api/webhooks/bitbucket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature": makeSig(body, secret),
      "X-Request-UUID": "test-uuid-1234",
      "X-Event-Key": eventKey,
    },
    body,
  });
}

describe("POST /api/webhooks/bitbucket", () => {
  beforeEach(() => {
    process.env.BITBUCKET_WEBHOOK_SECRET = BB_SECRET;
  });

  it("returns 401 when X-Hub-Signature is missing", async () => {
    const req = new Request("http://localhost/api/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Event-Key": "repo:push",
      },
      body: JSON.stringify({ repository: { full_name: "org/repo" } }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is invalid (tampered body)", async () => {
    const body = JSON.stringify({ repository: { full_name: "org/repo" } });
    const req = new Request("http://localhost/api/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature": makeSig("different-body"),
        "X-Event-Key": "repo:push",
      },
      body,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid repo:push event", async () => {
    const req = makeBitbucketRequest(
      { repository: { full_name: "org/repo" }, push: { changes: [] } },
      "repo:push",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("received");
  });

  it("returns 200 queued for pullrequest:created", async () => {
    const req = makeBitbucketRequest(
      { pullrequest: { id: 1, title: "New Feature" } },
      "pullrequest:created",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("queued");
  });

  it("returns 200 queued for pullrequest:updated", async () => {
    const req = makeBitbucketRequest(
      { pullrequest: { id: 1, title: "Updated PR" } },
      "pullrequest:updated",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("queued");
  });

  it("returns 200 ignored for untracked events", async () => {
    const req = makeBitbucketRequest(
      { comment: { text: "Nice PR!" } },
      "pullrequest:comment_created",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ignored");
  });

  it("returns 400 when X-Event-Key header is missing", async () => {
    const body = JSON.stringify({ repository: { full_name: "org/repo" } });
    const req = new Request("http://localhost/api/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature": makeSig(body),
      },
      body,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it("returns 500 when BITBUCKET_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.BITBUCKET_WEBHOOK_SECRET;
    const req = makeBitbucketRequest({ repository: { full_name: "org/repo" } }, "repo:push");
    const res = await POST(req as never);
    expect(res.status).toBe(500);
    process.env.BITBUCKET_WEBHOOK_SECRET = BB_SECRET;
  });

  it("returns 400 for invalid JSON payload", async () => {
    const badBody = "this-is-not-json{";
    const req = new Request("http://localhost/api/webhooks/bitbucket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature": makeSig(badBody),
        "X-Event-Key": "repo:push",
      },
      body: badBody,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it("returns 200 for pullrequest:fulfilled (PR merged)", async () => {
    const req = makeBitbucketRequest(
      { pullrequest: { id: 99, title: "Merged" } },
      "pullrequest:fulfilled",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("received");
  });
});

