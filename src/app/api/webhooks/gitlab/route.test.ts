/**
 * Integration tests for POST /api/webhooks/gitlab (#1466).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// ── Import (after mocks) ──────────────────────────────────────────────────────

import { POST } from "./route";

const GITLAB_SECRET = "my-gitlab-token-secret";

function makeGitLabRequest(
  body: Record<string, unknown>,
  event: string,
  token: string = GITLAB_SECRET,
): Request {
  return new Request("http://localhost/api/webhooks/gitlab", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gitlab-Token": token,
      "X-Gitlab-Event": event,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks/gitlab", () => {
  beforeEach(() => {
    process.env.GITLAB_WEBHOOK_TOKEN = GITLAB_SECRET;
  });

  it("returns 401 when X-Gitlab-Token header is missing", async () => {
    const req = new Request("http://localhost/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Event": "Push Hook",
      },
      body: JSON.stringify({ event: "push" }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Gitlab-Token is incorrect", async () => {
    const req = makeGitLabRequest({ event: "push" }, "Push Hook", "wrong-token");
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid Push Hook", async () => {
    const req = makeGitLabRequest(
      { ref: "refs/heads/main", repository: { id: 1 } },
      "Push Hook",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("received");
  });

  it("returns 200 for a valid Merge Request Hook", async () => {
    const req = makeGitLabRequest(
      { object_attributes: { action: "open", iid: 1 } },
      "Merge Request Hook",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("queued");
  });

  it("returns 200 ignored for untracked events", async () => {
    const req = makeGitLabRequest({ action: "open" }, "Note Hook");
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ignored");
  });

  it("returns 400 when X-Gitlab-Event header is missing", async () => {
    const req = new Request("http://localhost/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Token": GITLAB_SECRET,
      },
      body: JSON.stringify({ event: "push" }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it("returns 500 when GITLAB_WEBHOOK_TOKEN is not configured", async () => {
    delete process.env.GITLAB_WEBHOOK_TOKEN;
    const req = makeGitLabRequest({ event: "push" }, "Push Hook");
    const res = await POST(req as never);
    expect(res.status).toBe(500);
    process.env.GITLAB_WEBHOOK_TOKEN = GITLAB_SECRET;
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Token": GITLAB_SECRET,
        "X-Gitlab-Event": "Push Hook",
      },
      body: "not-valid-json{{",
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it("returns 200 for Pipeline Hook", async () => {
    const req = makeGitLabRequest(
      { object_attributes: { status: "success", id: 123 } },
      "Pipeline Hook",
    );
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("received");
  });
});

