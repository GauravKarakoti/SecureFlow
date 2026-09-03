import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import * as authModule from "@/auth";
import * as syncEngine from "@/lib/github/sync-user-repos";
import { checkRateLimitDetailed } from "@/lib/redis";
import { TIERS } from "@/lib/middleware/rate-limit";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// The per-user tier the route applies inside the handler. The IP tier wrapping
// it has its own middleware tests; stubbing the shared limiter keeps these
// assertions about the per-user budget.
vi.mock("@/lib/redis", () => ({
  checkRateLimitDetailed: vi.fn(),
}));

// The named-repository path resolves the id against the caller before doing
// anything (#749). Previously it looked nothing up at all, which is why the two
// cases below could pass a repository id that no fixture ever made real.
const repositoryFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  default: { repository: { findFirst: repositoryFindFirst } },
}));

const OWNED_REPO = {
  id: "repo-monorepo-1",
  fullName: "octocat/monorepo",
  owner: "octocat",
  isActive: true,
};

const logged: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    level: "debug",
    debug: vi.fn(),
    info: (message: string, meta?: Record<string, unknown>) =>
      logged.push({ level: "info", message, meta }),
    warn: vi.fn(),
    error: (message: string, meta?: Record<string, unknown>) =>
      logged.push({ level: "error", message, meta }),
    child: vi.fn(),
  }),
  logger: {},
}));

/** The limiter answering "allowed". */
const allow = () => ({
  allowed: true,
  limit: TIERS.REPO_SYNC.limit,
  remaining: TIERS.REPO_SYNC.limit - 1,
  resetAt: Date.now() + 60_000,
  degraded: false,
});

/** The limiter answering "blocked", resetting `afterMs` from now. */
const block = (afterMs = 30_000) => ({
  allowed: false,
  limit: TIERS.REPO_SYNC.limit,
  remaining: 0,
  resetAt: Date.now() + afterMs,
  degraded: false,
});

/**
 * A request for the route.
 *
 * The handler is wrapped in `withRateLimit`, which reads `req.headers` to
 * resolve the client IP, so it needs one. Next always supplies a request; the
 * previous tests called `POST()` bare, which no caller ever does.
 */
const request = () =>
  new Request("http://localhost/api/repositories/sync", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7" },
  }) as never;

const session = (overrides: Record<string, unknown> = {}) =>
  ({
    user: { id: "user-123", githubLogin: "octocat" },
    accessToken: "gho_secret123",
    ...overrides,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  logged.length = 0;
  vi.mocked(checkRateLimitDetailed).mockResolvedValue(allow());
  repositoryFindFirst.mockResolvedValue(OWNED_REPO);
});

describe("POST /api/repositories/sync route (#634)", () => {
  it("returns 401 Unauthorized when no authenticated session exists", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null);

    const response = await POST(request());
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("triggers syncUserRepositories and returns 200 with result when authenticated", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());

    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 5,
      hasInstallation: true,
      installationId: 443322,
    });

    const response = await POST(request());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({
      synced: 5,
      hasInstallation: true,
      installationId: 443322,
    });
    expect(syncEngine.syncUserRepositories).toHaveBeenCalledWith(
      "user-123",
      "octocat",
      "gho_secret123"
    );
  });

  it("returns 500 when synchronization engine throws an unexpected error", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session({ user: { id: "user-123" } }));

    vi.spyOn(syncEngine, "syncUserRepositories").mockRejectedValue(
      new Error("Database deadlock")
    );

    const response = await POST(request());
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe("Failed to synchronize repositories");
  });

  it("runs the real sync for a named repository instead of counting fabricated files", async () => {
    // This branch used to build 4500 hardcoded paths, count them in a loop
    // whose body was `totalSyncedFiles++`, and answer
    // `{ success: true, status: "COMPLETED", synchronizedFilesCount: 4500 }`
    // without a single query, GitHub call or write (#749).
    vi.mocked(authModule.auth).mockResolvedValue(session());
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 4,
      hasInstallation: true,
      installationId: 443322,
      skipped: 1,
      failed: 0,
    });

    const mockReq = {
      json: vi.fn().mockResolvedValue({ repositoryId: "repo-monorepo-1", branch: "main" }),
      signal: { aborted: false },
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    } as any;

    const response = await POST(mockReq);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(syncEngine.syncUserRepositories).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({
      success: true,
      status: "COMPLETED",
      repository: OWNED_REPO,
      synced: 4,
      skipped: 1,
      failed: 0,
    });
    expect(data).not.toHaveProperty("synchronizedFilesCount");
    expect(data).not.toHaveProperty("batchesProcessed");
  });

  it("resolves the named repository against the caller", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 1,
      hasInstallation: true,
    });

    const mockReq = {
      json: vi.fn().mockResolvedValue({ repositoryId: "repo-monorepo-1" }),
      signal: { aborted: false },
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    } as any;

    await POST(mockReq);

    expect(repositoryFindFirst).toHaveBeenCalledWith({
      where: { id: "repo-monorepo-1", userId: "user-123" },
      select: { id: true, fullName: true, owner: true, isActive: true },
    });
  });

  it("returns 404 for a repository the caller does not own", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    const syncSpy = vi.spyOn(syncEngine, "syncUserRepositories");
    repositoryFindFirst.mockResolvedValue(null);

    const mockReq = {
      json: vi.fn().mockResolvedValue({ repositoryId: "someone-elses-repo" }),
      signal: { aborted: false },
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    } as any;

    const response = await POST(mockReq);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Repository not found" });
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("rejects an unusable repositoryId rather than falling through", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    const syncSpy = vi.spyOn(syncEngine, "syncUserRepositories");

    for (const repositoryId of ["", "   ", 42, { $ne: null }]) {
      const mockReq = {
        json: vi.fn().mockResolvedValue({ repositoryId }),
        signal: { aborted: false },
        headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
      } as any;

      const response = await POST(mockReq);
      expect(response.status).toBe(400);
    }

    expect(syncSpy).not.toHaveBeenCalled();
    expect(repositoryFindFirst).not.toHaveBeenCalled();
  });

  it("does not report success when the account has no installation", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 0,
      hasInstallation: false,
    });

    const mockReq = {
      json: vi.fn().mockResolvedValue({ repositoryId: "repo-monorepo-1" }),
      signal: { aborted: false },
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    } as any;

    const data = await (await POST(mockReq)).json();
    expect(data.success).toBe(false);
    expect(data.status).toBe("NO_INSTALLATION");
  });

  it("returns 408 when a named sync is aborted by client signal (#674)", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    const syncSpy = vi.spyOn(syncEngine, "syncUserRepositories");

    const mockReq = {
      json: vi.fn().mockResolvedValue({ repositoryId: "repo-monorepo-1" }),
      signal: { aborted: true },
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    } as any;

    const response = await POST(mockReq);
    expect(response.status).toBe(408);

    const data = await response.json();
    expect(data.error).toBe("Sync task aborted by client timeout signal");
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("leaves the full-sync response shape alone", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 2,
      hasInstallation: true,
    });

    const data = await (await POST(request())).json();

    expect(data).toEqual({ synced: 2, hasInstallation: true });
    expect(repositoryFindFirst).not.toHaveBeenCalled();
  });
});

describe("rate limiting (#690)", () => {
  beforeEach(() => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 1,
      hasInstallation: true,
    });
  });

  it("applies a per-user budget", async () => {
    // The route had no limit of any kind. Authentication bounded who could call
    // it, not how often, and every call performed a full installation walk.
    await POST(request());

    expect(checkRateLimitDetailed).toHaveBeenCalledWith(
      "rate-limit:repo-sync:user:user-123",
      TIERS.REPO_SYNC.limit,
      TIERS.REPO_SYNC.windowSeconds,
      expect.objectContaining({ fallbackStrategy: "fail-closed" })
    );
  });

  it("keys a budget by user as well as by address", async () => {
    // Several developers behind one office NAT should not share a sync budget,
    // and one account rotating through addresses should not escape it. Both
    // tiers apply: the IP one wraps the handler, the user one runs inside it.
    vi.mocked(authModule.auth).mockResolvedValue(session({ user: { id: "someone-else" } }));

    await POST(request());

    const keys = vi.mocked(checkRateLimitDetailed).mock.calls.map((call) => call[0]);
    expect(keys).toContain("rate-limit:repo-sync:user:someone-else");
    expect(keys.some((key) => key.startsWith("rate-limit:repo-sync:ip:"))).toBe(true);
  });

  it("fails closed, so a Redis outage does not lift the limit", async () => {
    expect(TIERS.REPO_SYNC.fallbackStrategy).toBe("fail-closed");
  });

  it("returns 429 with the standard headers once the budget is spent", async () => {
    vi.mocked(checkRateLimitDetailed).mockResolvedValue(block());

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe(String(TIERS.REPO_SYNC.limit));
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("does not perform the sync when the budget is spent", async () => {
    vi.mocked(checkRateLimitDetailed).mockResolvedValue(block());

    await POST(request());

    expect(syncEngine.syncUserRepositories).not.toHaveBeenCalled();
  });

  it("reports the real time left, not the whole window", async () => {
    vi.mocked(checkRateLimitDetailed).mockResolvedValue(block(5_000));

    const response = await POST(request());

    expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(6);
  });

  it("does not spend a user budget for an unauthenticated caller", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null);

    await POST(request());

    // The IP tier still applies — it wraps the handler and has no session to
    // consult — but there is no user key to charge, and the 401 is cheaper than
    // a second Redis round trip.
    const keys = vi.mocked(checkRateLimitDetailed).mock.calls.map((call) => call[0]);
    expect(keys.some((key) => key.startsWith("rate-limit:repo-sync:user:"))).toBe(false);
  });
});

describe("error handling (#690)", () => {
  beforeEach(() => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
  });

  it("does not return the raw provider message to the caller", async () => {
    // The old response was
    //   { error: "Failed to synchronize repositories", message: error?.message }
    // and those messages come from Octokit, from the GitHub App private-key
    // parser, or from Prisma.
    vi.spyOn(syncEngine, "syncUserRepositories").mockRejectedValue(
      new Error("error:0909006C:PEM routines:get_name:no start line — GITHUB_APP_PRIVATE_KEY")
    );

    const response = await POST(request());
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("PEM routines");
    expect(body).not.toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it("keeps the raw error in the log, where it is useful", async () => {
    vi.spyOn(syncEngine, "syncUserRepositories").mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432")
    );

    await POST(request());

    const entry = logged.find((item) => item.level === "error");
    expect(entry).toBeDefined();
    expect((entry!.meta?.error as Error).message).toContain("ECONNREFUSED");
  });

  it("logs the actor as a hash rather than the raw user id", async () => {
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 2,
      hasInstallation: true,
    });

    await POST(request());

    const entry = logged.find((item) => item.level === "info");
    expect(entry?.meta?.actor).toMatch(/^usr:[0-9a-f]{12}$/);
    expect(entry?.meta?.actor).not.toContain("user-123");
  });

  it("scrubs the error the sync engine reports without throwing", async () => {
    // syncUserRepositories reports a partial failure through `result.error`
    // rather than by throwing, and that field is `err?.message` from the same
    // provider errors — so the 200 path leaked too.
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 0,
      hasInstallation: true,
      error: "Bad credentials for token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const response = await POST(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("leaves a clean result untouched", async () => {
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 3,
      hasInstallation: true,
      skipped: 1,
      skippedRepositories: ["other/repo"],
    });

    const data = await (await POST(request())).json();

    expect(data).toEqual({
      synced: 3,
      hasInstallation: true,
      skipped: 1,
      skippedRepositories: ["other/repo"],
    });
  });
});

describe("caching (#690)", () => {
  it("marks every response no-store", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(session());
    vi.spyOn(syncEngine, "syncUserRepositories").mockResolvedValue({
      synced: 1,
      hasInstallation: true,
    });

    expect((await POST(request())).headers.get("Cache-Control")).toBe("no-store");

    vi.mocked(authModule.auth).mockResolvedValue(null);
    expect((await POST(request())).headers.get("Cache-Control")).toBe("no-store");
  });
});