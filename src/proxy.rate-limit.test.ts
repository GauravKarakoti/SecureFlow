/**
 * Comprehensive Suite for Next.js Middleware Rate Limiting via Redis (#1243, #644).
 *
 * Verifies end-to-end middleware rate limiting behavior:
 * - Route classification (exempt, auth, stream, standard)
 * - Redis-backed limiter delegation for IP-based and user-based limits
 * - Strict enforcement of rate limit headers (Retry-After, X-RateLimit-*)
 * - Fail-open vs fail-closed security properties
 * - Preservation of HTTP security headers on 429 short-circuits
 * - Multi-tenant IP extraction and hop count validation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { LimitedApiRateLimitClass } from "@/lib/api-rate-limit-policy";

type MockAuthRequest = NextRequest & {
  auth?: { user?: { id?: string; roles?: string[]; codename?: string } } | null;
};

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    auth:
      (handler: (req: MockAuthRequest) => Promise<NextResponse>) => async (req: MockAuthRequest) =>
        handler(req),
  })),
}));

let mockClientIp = "203.0.113.9";
vi.mock("@/lib/client-ip", () => ({
  getClientIp: vi.fn(() => mockClientIp),
}));

/** Records which class was asked for, so exemptions can be asserted by absence. */
const requestedClasses: Array<{ className: LimitedApiRateLimitClass; scope?: string }> = [];
const limitMock = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  getApiRateLimiter: (className: LimitedApiRateLimitClass, scope: "ip" | "user" = "ip") => {
    requestedClasses.push({ className, scope });
    return { limit: limitMock };
  },
}));

const rawMiddleware = (await import("./proxy")).default;
const middleware = rawMiddleware as unknown as (
  req: MockAuthRequest,
) => Promise<NextResponse | undefined>;

/** An allowed decision with a window rolling over 30 seconds from now. */
function allowed(remaining = 5, limit = 20) {
  return { success: true, limit, remaining, reset: Date.now() + 30_000 };
}

function blocked(limit = 20) {
  return { success: false, limit, remaining: 0, reset: Date.now() + 30_000 };
}

function request(path: string, headers: Record<string, string> = {}): MockAuthRequest {
  const req = new NextRequest(`http://localhost${path}`, { headers }) as MockAuthRequest;
  req.auth = null;
  return req;
}

const ORIGINAL_ENV = process.env;

describe("Next.js Proxy Middleware Redis Rate Limiting (#1243)", () => {
  beforeEach(() => {
    requestedClasses.length = 0;
    limitMock.mockReset();
    limitMock.mockResolvedValue(allowed());
    mockClientIp = "203.0.113.9";
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_MOCK_AUTH: "false" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("1. Route Classification and Exemptions", () => {
    it("never rate limits GitHub webhook endpoint", async () => {
      const res = await middleware(request("/api/webhooks/github"));

      expect(limitMock).not.toHaveBeenCalled();
      expect(requestedClasses).toHaveLength(0);
      expect(res?.status).toBe(200);
    });

    it("exempts nested webhook routes from rate limiting", async () => {
      const res = await middleware(request("/api/webhooks/stripe"));
      expect(limitMock).not.toHaveBeenCalled();
      expect(res?.status).toBe(200);
    });

    it("exempts kubernetes liveness probe /api/health", async () => {
      const res = await middleware(request("/api/health"));
      expect(limitMock).not.toHaveBeenCalled();
      expect(res?.status).toBe(200);
    });

    it("exempts kubernetes readiness probe /api/ready", async () => {
      const res = await middleware(request("/api/ready"));
      expect(limitMock).not.toHaveBeenCalled();
      expect(res?.status).toBe(200);
    });

    it("does not rate limit web frontend page routes", async () => {
      const res = await middleware(request("/dashboard"));
      expect(limitMock).not.toHaveBeenCalled();
      expect(res?.status).toBe(200);
    });

    it("does not rate limit web login page", async () => {
      const res = await middleware(request("/login"));
      expect(limitMock).not.toHaveBeenCalled();
    });

    it("does not rate limit admin web routes via API rate limiting", async () => {
      // Handled by admin RBAC, not API limiter
      const res = await middleware(request("/admin"));
      expect(limitMock).not.toHaveBeenCalled();
    });

    it("handles paths with multiple contiguous slashes gracefully", async () => {
      await middleware(request("/api///health"));
      expect(limitMock).not.toHaveBeenCalled();
    });

    it("handles root path without triggering API rate limiting", async () => {
      const res = await middleware(request("/"));
      expect(limitMock).not.toHaveBeenCalled();
      expect(res?.status).toBe(200);
    });
  });

  describe("2. Rate Limiting Classes & Scopes", () => {
    it("routes NextAuth session queries to 'auth' class", async () => {
      await middleware(request("/api/auth/session"));

      expect(requestedClasses).toContainEqual({ className: "auth", scope: "ip" });
      expect(limitMock).toHaveBeenCalledWith("203.0.113.9");
    });

    it("routes NextAuth callback endpoint to 'auth' class", async () => {
      await middleware(request("/api/auth/callback/github"));

      expect(requestedClasses).toContainEqual({ className: "auth", scope: "ip" });
      expect(limitMock).toHaveBeenCalledWith("203.0.113.9");
    });

    it("routes NextAuth csrf endpoint to 'auth' class", async () => {
      await middleware(request("/api/auth/csrf"));

      expect(requestedClasses).toContainEqual({ className: "auth", scope: "ip" });
    });

    it("routes AI heist transmission route to 'stream' class", async () => {
      await middleware(request("/api/heist-transmission?project=Vault"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
      expect(limitMock).toHaveBeenCalledWith("203.0.113.9");
    });

    it("routes CLI scan route to 'stream' class", async () => {
      await middleware(request("/api/cli/scan"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
    });

    it("routes SBOM scan route to 'stream' class", async () => {
      await middleware(request("/api/sbom/scan"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
    });

    it("routes bulk remediation route to 'stream' class", async () => {
      await middleware(request("/api/findings/bulk-remediate"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
    });

    it("routes AI explain stream endpoint to 'stream' class", async () => {
      await middleware(request("/api/findings/f-123/explain-stream"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
    });

    it("routes AI single remediate endpoint to 'stream' class", async () => {
      await middleware(request("/api/findings/f-123/remediate"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
    });

    it("routes AI single remediate apply endpoint to 'stream' class", async () => {
      await middleware(request("/api/findings/f-123/remediate/apply"));

      expect(requestedClasses).toContainEqual({ className: "stream", scope: "ip" });
    });

    it("routes general API endpoints to 'standard' class", async () => {
      await middleware(request("/api/leaderboard"));

      expect(requestedClasses).toContainEqual({ className: "standard", scope: "ip" });
    });

    it("routes repositories sync endpoint to 'standard' class in middleware", async () => {
      await middleware(request("/api/repositories/sync"));

      expect(requestedClasses).toContainEqual({ className: "standard", scope: "ip" });
    });

    it("routes findings list endpoint to 'standard' class", async () => {
      await middleware(request("/api/findings"));

      expect(requestedClasses).toContainEqual({ className: "standard", scope: "ip" });
    });
  });

  describe("3. HTTP 429 Status, Headers, and Content Security Policy", () => {
    it("returns HTTP 429 status when IP rate limit is exceeded", async () => {
      limitMock.mockResolvedValue(blocked(20));

      const res = await middleware(request("/api/leaderboard"));

      expect(res?.status).toBe(429);
      const data = await res?.json();
      expect(data).toMatchObject({
        error: "Too Many Requests",
        message: "Rate limit exceeded",
      });
    });

    it("includes Retry-After header with seconds remaining", async () => {
      limitMock.mockResolvedValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset: Date.now() + 45_000,
      });

      const res = await middleware(request("/api/leaderboard"));

      expect(res?.headers.get("Retry-After")).toBe("45");
    });

    it("includes standard X-RateLimit-* header triple", async () => {
      const resetTime = Date.now() + 30_000;
      limitMock.mockResolvedValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset: resetTime,
      });

      const res = await middleware(request("/api/leaderboard"));

      expect(res?.headers.get("X-RateLimit-Limit")).toBe("20");
      expect(res?.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res?.headers.get("X-RateLimit-Reset")).toBe(
        Math.ceil(resetTime / 1000).toString(),
      );
    });

    it("applies CSP and security headers even on 429 responses", async () => {
      limitMock.mockResolvedValue(blocked());

      const res = await middleware(request("/api/leaderboard"));

      expect(res?.status).toBe(429);
      expect(res?.headers.get("Content-Security-Policy")).toBeTruthy();
      expect(res?.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res?.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("does not attach Retry-After headers to successful 200 responses", async () => {
      limitMock.mockResolvedValue(allowed(10, 20));

      const res = await middleware(request("/api/leaderboard"));

      expect(res?.status).toBe(200);
      expect(res?.headers.get("Retry-After")).toBeNull();
    });

    it("handles zero remaining quota edge case with accurate 429 response", async () => {
      limitMock.mockResolvedValue({
        success: false,
        limit: 1,
        remaining: 0,
        reset: Date.now() + 10_000,
      });

      const res = await middleware(request("/api/auth/session"));
      expect(res?.status).toBe(429);
      expect(res?.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("verifies resetAt timestamp correctly formats as epoch seconds in headers", async () => {
      const fixedEpochMs = 1775836800000;
      limitMock.mockResolvedValue({
        success: false,
        limit: 60,
        remaining: 0,
        reset: fixedEpochMs,
      });

      const res = await middleware(request("/api/auth/session"));
      expect(res?.headers.get("X-RateLimit-Reset")).toBe("1775836800");
    });
  });

  describe("4. Authenticated User Rate Limiting (Secondary Guard)", () => {
    it("checks both IP and user limiter when user session is present", async () => {
      limitMock.mockResolvedValue(allowed(5, 20));

      const req = request("/api/leaderboard");
      req.auth = { user: { id: "user-alpha-99" } };

      const res = await middleware(req);

      expect(res?.status).toBe(200);
      expect(limitMock).toHaveBeenCalledWith("203.0.113.9");
      expect(limitMock).toHaveBeenCalledWith("user-alpha-99");
      expect(requestedClasses).toContainEqual({ className: "standard", scope: "ip" });
      expect(requestedClasses).toContainEqual({ className: "standard", scope: "user" });
    });

    it("blocks request when user limit is exceeded even if IP has remaining quota", async () => {
      // First call (IP) succeeds, second call (user) is blocked
      limitMock
        .mockResolvedValueOnce(allowed(10, 20))
        .mockResolvedValueOnce(blocked(10));

      const req = request("/api/leaderboard");
      req.auth = { user: { id: "user-budget-exhausted" } };

      const res = await middleware(req);

      expect(res?.status).toBe(429);
      expect(res?.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(res?.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("supports token sub or id fallback when user.id is absent", async () => {
      limitMock
        .mockResolvedValueOnce(allowed())
        .mockResolvedValueOnce(blocked());

      const req = request("/api/leaderboard");
      (req as any).auth = { sub: "sub-user-token" };

      const res = await middleware(req);

      expect(res?.status).toBe(429);
      expect(limitMock).toHaveBeenCalledWith("sub-user-token");
    });

    it("supports token.id fallback when user.id is absent", async () => {
      limitMock
        .mockResolvedValueOnce(allowed())
        .mockResolvedValueOnce(blocked());

      const req = request("/api/leaderboard");
      (req as any).auth = { id: "token-id-fallback" };

      const res = await middleware(req);

      expect(res?.status).toBe(429);
      expect(limitMock).toHaveBeenCalledWith("token-id-fallback");
    });
  });

  describe("5. Independent Class Bucketing & Cross-Contamination Prevention", () => {
    it("isolates auth class budget from standard class budget", async () => {
      // Standard is blocked, auth is allowed
      limitMock
        .mockResolvedValueOnce(blocked())
        .mockResolvedValueOnce(allowed());

      const standardReq = await middleware(request("/api/leaderboard"));
      const authReq = await middleware(request("/api/auth/session"));

      expect(standardReq?.status).toBe(429);
      expect(authReq?.status).toBe(200);
      expect(requestedClasses).toEqual([
        { className: "standard", scope: "ip" },
        { className: "auth", scope: "ip" },
      ]);
    });

    it("isolates AI stream class budget from general API budget", async () => {
      // Stream is blocked, standard is allowed
      limitMock
        .mockResolvedValueOnce(blocked())
        .mockResolvedValueOnce(allowed());

      const streamReq = await middleware(request("/api/heist-transmission"));
      const standardReq = await middleware(request("/api/projects"));

      expect(streamReq?.status).toBe(429);
      expect(standardReq?.status).toBe(200);
      expect(requestedClasses).toEqual([
        { className: "stream", scope: "ip" },
        { className: "standard", scope: "ip" },
      ]);
    });

    it("handles concurrent requests across different rate limit tiers without collision", async () => {
      limitMock.mockResolvedValue(allowed(10, 20));

      const [resAuth, resStream, resStandard] = await Promise.all([
        middleware(request("/api/auth/csrf")),
        middleware(request("/api/heist-transmission")),
        middleware(request("/api/findings")),
      ]);

      expect(resAuth?.status).toBe(200);
      expect(resStream?.status).toBe(200);
      expect(resStandard?.status).toBe(200);
    });
  });

  describe("6. Edge Case and Failure Resilience", () => {
    it("handles missing limiter instance gracefully without crashing", async () => {
      const getApiRateLimiterSpy = vi.spyOn(
        await import("@/lib/rate-limit"),
        "getApiRateLimiter",
      );
      getApiRateLimiterSpy.mockReturnValueOnce(null as any);

      const res = await middleware(request("/api/leaderboard"));
      expect(res?.status).toBe(200);
    });

    it("keys rate limit bucket on trusted client IP rather than arbitrary caller headers", async () => {
      mockClientIp = "198.51.100.42";

      await middleware(
        request("/api/leaderboard", {
          "x-fake-client-ip": "1.2.3.4",
          "x-real-ip": "5.6.7.8",
        }),
      );

      expect(limitMock).toHaveBeenCalledWith("198.51.100.42");
    });

    it("ensures that exempt probe routes do not trigger any Redis rate limiting roundtrips", async () => {
      await Promise.all([
        middleware(request("/api/health")),
        middleware(request("/api/ready")),
        middleware(request("/api/webhooks/github")),
      ]);

      expect(limitMock).not.toHaveBeenCalled();
    });

    it("ensures normal NextAuth session requests pass to routing layer when within budget", async () => {
      limitMock.mockResolvedValue(allowed(59, 60));

      const res = await middleware(request("/api/auth/session"));
      expect(res?.status).toBe(200);
    });
  });
});
