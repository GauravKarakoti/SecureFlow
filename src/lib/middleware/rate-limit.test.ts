import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "../redis";

const checkRateLimitDetailed = vi.fn();

vi.mock("../redis", () => ({
  checkRateLimitDetailed: (...args: unknown[]) => checkRateLimitDetailed(...args),
}));

vi.mock("../client-ip", () => ({
  getClientIp: () => "203.0.113.10",
}));

vi.mock("next/server", () => {
  class MockHeaders {
    private store = new Map<string, string>();
    constructor(init?: Record<string, string>) {
      for (const [k, v] of Object.entries(init ?? {})) this.store.set(k, v);
    }
    get(key: string) {
      return this.store.get(key) ?? null;
    }
    set(key: string, value: string) {
      this.store.set(key, value);
    }
  }
  return {
    NextRequest: class MockNextRequest {
      constructor(public headers: unknown = {}) {}
    },
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        body,
        status: init?.status ?? 200,
        headers: new MockHeaders(init?.headers),
      }),
    },
  };
});

import { NextRequest, NextResponse } from "next/server";
import { TIERS, buildRateLimitHeaders, secondsUntilReset, withRateLimit } from "./rate-limit";

function decision(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return {
    allowed: true,
    limit: 50,
    remaining: 49,
    resetAt: 1_800_000_000_000,
    ...overrides,
  };
}

const config = { limit: 50, windowSeconds: 60, keyPrefix: "test" };
const okHandler = vi.fn(async () => NextResponse.json({ ok: true }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("secondsUntilReset", () => {
  it("returns the seconds left in the window, floored at 1", () => {
    const now = 1_000_000;
    expect(secondsUntilReset(now + 61_000, now)).toBe(61);
    expect(secondsUntilReset(now + 1, now)).toBe(1);
    expect(secondsUntilReset(now - 5_000, now)).toBe(1);
  });
});

describe("buildRateLimitHeaders", () => {
  it("expresses the reset as epoch seconds", () => {
    expect(buildRateLimitHeaders(decision())).toEqual({
      "X-RateLimit-Limit": "50",
      "X-RateLimit-Remaining": "49",
      "X-RateLimit-Reset": "1800000000",
    });
  });
});

describe("withRateLimit", () => {
  it("passes allowed requests through and advertises the measured budget", async () => {
    checkRateLimitDetailed.mockResolvedValue(decision());
    const res: any = await withRateLimit(okHandler, config)(new NextRequest() as any);

    expect(okHandler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("50");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("49");
    expect(checkRateLimitDetailed).toHaveBeenCalledWith(
      "rate-limit:test:203.0.113.10",
      50,
      60,
      expect.objectContaining({ fallbackStrategy: "fail-open" }),
    );
  });

  it("returns 429 with Retry-After and measured headers when denied", async () => {
    checkRateLimitDetailed.mockResolvedValue(
      decision({ allowed: false, remaining: 0, resetAt: Date.now() + 30_000 }),
    );
    const res: any = await withRateLimit(okHandler, config)(new NextRequest() as any);

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "Too Many Requests" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(30);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("50");
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("does not advertise invented X-RateLimit headers on a degraded 429", async () => {
    // Fail-closed during a Redis outage: the limiter never measured anything,
    // so it must not fabricate budget headers — Retry-After is still sent.
    checkRateLimitDetailed.mockResolvedValue(
      decision({ allowed: false, remaining: 0, degraded: true }),
    );
    const res: any = await withRateLimit(okHandler, {
      ...config,
      fallbackStrategy: "fail-closed",
    })(new NextRequest() as any);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(res.headers.get("X-RateLimit-Reset")).toBeNull();
  });

  it("does not advertise invented headers on a degraded allow either", async () => {
    checkRateLimitDetailed.mockResolvedValue(decision({ degraded: true }));
    const res: any = await withRateLimit(okHandler, config)(new NextRequest() as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("fails open when the limiter throws and the strategy is fail-open", async () => {
    checkRateLimitDetailed.mockRejectedValue(new Error("redis down"));
    const res: any = await withRateLimit(okHandler, config)(new NextRequest() as any);
    expect(res.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it("fails closed (429, degraded) when the limiter throws and the strategy is fail-closed", async () => {
    checkRateLimitDetailed.mockRejectedValue(new Error("redis down"));
    const res: any = await withRateLimit(okHandler, {
      ...config,
      fallbackStrategy: "fail-closed",
    })(new NextRequest() as any);

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("TIERS presets use the documented strategies", () => {
    expect(TIERS.AUTH.fallbackStrategy).toBe("fail-closed");
    expect(TIERS.STANDARD.fallbackStrategy).toBe("fail-open");
    expect(TIERS.ADMIN.fallbackStrategy).toBe("fail-closed");
  });
});
