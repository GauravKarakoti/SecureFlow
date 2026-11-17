import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  getModelCircuitBreaker,
  resetModelCircuitBreakers,
  tripModelCircuitBreaker,
  CircuitState,
} from "@/ai/resilience";

const { authMock, mockFindFirst, mockUpsert, generatePatchMock, mockCheckRateLimitDetailed } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    mockFindFirst: vi.fn(),
    mockUpsert: vi.fn(),
    generatePatchMock: vi.fn(),
    mockCheckRateLimitDetailed: vi.fn(),
  }));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findFirst: mockFindFirst },
    remediationPatch: { upsert: mockUpsert },
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimitDetailed: mockCheckRateLimitDetailed,
  checkRateLimit: vi.fn(async () => true),
  redis: null,
}));

vi.mock("@/ai/flows/generate-remediation-patch", () => ({
  generateRemediationPatchFlow: generatePatchMock,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  withRateLimit: vi.fn((handler: (...args: unknown[]) => unknown) => handler),
  TIERS: {
    AI_STREAM: { limit: 10, windowSeconds: 60, fallbackStrategy: "fail-closed", timeoutMs: 1000 },
    AI_STREAM_USER: {
      limit: 10,
      windowSeconds: 60,
      fallbackStrategy: "fail-closed",
      timeoutMs: 1000,
    },
  },
  buildRateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Limit": "10" })),
  secondsUntilReset: vi.fn(() => 60),
}));

vi.mock("@/lib/middleware/error-handler", () => ({
  withErrorHandler: vi.fn((handler: (...args: unknown[]) => unknown) => handler),
  AppError: class AppError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  },
}));

import { POST } from "./route";

function makeRequest(id: string) {
  return new NextRequest(`http://localhost/api/findings/${id}/remediate`, {
    method: "POST",
  });
}

const mockFinding = {
  id: "finding-breaker-1",
  type: "VULNERABILITY",
  codeSnippet: "db.query('SELECT * FROM users WHERE id = ' + id)",
  explanation: "SQL injection vulnerability",
  remediation: "Use parameterized queries.",
  fileLocation: "src/db.ts",
};

describe("POST /api/findings/[id]/remediate - Circuit Breaker & Provider Resilience (#1587)", () => {
  const AI_MODEL = "groq/openai/gpt-oss-20b";

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();

    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mockCheckRateLimitDetailed.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: Date.now() + 60_000,
      degraded: false,
    });
    mockFindFirst.mockResolvedValue(mockFinding);
    mockUpsert.mockResolvedValue({
      id: "patch-1",
      findingId: "finding-breaker-1",
      patchDiff:
        "--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-db.query(...)\n+db.query(sql, [id])",
      status: "GENERATED",
    });

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
    vi.restoreAllMocks();
  });

  it("returns 503 AI_UNAVAILABLE when AI circuit breaker is OPEN", async () => {
    tripModelCircuitBreaker(AI_MODEL);
    const breaker = getModelCircuitBreaker(AI_MODEL);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    generatePatchMock.mockResolvedValue({
      patchDiff: "",
      explanation: "The AI remediation service is temporarily unavailable. Please review manually.",
      failureReason: "unavailable",
    });

    const response = await POST(makeRequest("finding-breaker-1"), {
      params: Promise.resolve({ id: "finding-breaker-1" }),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: "The AI remediation service is temporarily unavailable. Please review manually.",
      code: "AI_UNAVAILABLE",
      retryable: true,
    });

    // An empty or failed patch must not be persisted into the database
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After header when AI provider trips rate limit", async () => {
    const breaker = getModelCircuitBreaker(AI_MODEL, { failureThreshold: 3 });

    generatePatchMock.mockImplementation(async () => {
      breaker.trip();
      return {
        patchDiff: "",
        explanation: "The AI remediation service is temporarily unavailable: rate limit reached.",
        failureReason: "rate_limit",
      };
    });

    const response = await POST(makeRequest("finding-breaker-1"), {
      params: Promise.resolve({ id: "finding-breaker-1" }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: "The AI remediation service is temporarily unavailable: rate limit reached.",
      code: "AI_RATE_LIMITED",
      retryable: true,
    });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it("handles HALF_OPEN probe success: resets breaker and persists generated patch", async () => {
    const breaker = getModelCircuitBreaker(AI_MODEL, {
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });
    breaker.trip(10);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Wait for resetTimeoutMs so breaker transitions to HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Half-open trial probe succeeds via execute, resetting breaker to CLOSED
    generatePatchMock.mockImplementation(async () => {
      return await breaker.execute(async () => ({
        patchDiff: "--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-query\n+parameterized",
        explanation: "Replaced with safe parameterized query.",
      }));
    });

    const response = await POST(makeRequest("finding-breaker-1"), {
      params: Promise.resolve({ id: "finding-breaker-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.explanation).toBe("Replaced with safe parameterized query.");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { findingId: "finding-breaker-1" },
        update: expect.objectContaining({ status: "GENERATED" }),
      }),
    );
  });

  it("handles HALF_OPEN probe failure: re-trips breaker to OPEN and returns 503", async () => {
    const breaker = getModelCircuitBreaker(AI_MODEL, {
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });
    breaker.trip(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Trial probe fails during half-open test
    generatePatchMock.mockImplementation(async () => {
      try {
        await breaker.execute(async () => {
          throw new Error("AI service timeout during recovery probe.");
        });
      } catch {
        // execute marks failure and rethrows
      }
      return {
        patchDiff: "",
        explanation: "AI service timeout during recovery probe.",
        failureReason: "timeout",
      };
    });

    const response = await POST(makeRequest("finding-breaker-1"), {
      params: Promise.resolve({ id: "finding-breaker-1" }),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("AI_UNAVAILABLE");
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
