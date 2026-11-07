import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  getModelCircuitBreaker,
  resetModelCircuitBreakers,
  tripModelCircuitBreaker,
  CircuitState,
} from "@/ai/resilience";

const {
  authMock,
  findingFindUniqueMock,
  findingUpdateMock,
  checkRateLimitMock,
  streamGeneratorMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  findingFindUniqueMock: vi.fn(),
  findingUpdateMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  streamGeneratorMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: {
      findUnique: findingFindUniqueMock,
      update: findingUpdateMock,
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: checkRateLimitMock,
  checkRateLimitDetailed: vi.fn(async () => ({
    allowed: true,
    limit: 10,
    remaining: 9,
    resetAt: Date.now() + 60000,
    degraded: false,
  })),
  redis: null,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: {
    AI_STREAM: { limit: 20, windowSeconds: 60, fallbackStrategy: "fail-closed", timeoutMs: 1000 },
    AI_STREAM_USER: {
      limit: 10,
      windowSeconds: 60,
      fallbackStrategy: "fail-closed",
      timeoutMs: 1000,
    },
  },
  withRateLimit: <T>(handler: T): T => handler,
}));

vi.mock("@/ai/flows/security-explanation-stream", () => ({
  streamDeveloperSecurityExplanations: streamGeneratorMock,
}));

import { GET } from "./route";

const mockFinding = {
  id: "finding-breaker-1",
  type: "VULNERABILITY",
  severity: "CRITICAL",
  fileLocation: "src/auth/session.ts",
  codeSnippet: "eval(untrustedInput)",
  scanResult: { pullRequest: { repository: { userId: "user-breaker-1" } } },
};

async function readStreamEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    for (const line of text.split("\n\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        try {
          events.push(JSON.parse(trimmed.slice(6)));
        } catch {
          // Ignore incomplete chunks if any
        }
      }
    }
  }

  return events;
}

function callEndpoint(findingId = "finding-breaker-1") {
  const req = new NextRequest(`http://localhost/api/findings/${findingId}/explain-stream`);
  return GET(req, { params: Promise.resolve({ id: findingId }) });
}

describe("GET /api/findings/[id]/explain-stream - Circuit Breaker & Provider Outage Resilience (#1553)", () => {
  const PRIMARY_MODEL = "groq/openai/gpt-oss-20b";
  const FALLBACK_MODEL = "groq/openai/gpt-oss-120b";

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    authMock.mockResolvedValue({ user: { id: "user-breaker-1" } });
    checkRateLimitMock.mockResolvedValue(true);
    findingFindUniqueMock.mockResolvedValue(mockFinding);
    findingUpdateMock.mockResolvedValue({});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
    vi.restoreAllMocks();
  });

  it("yields degraded error frame when primary AI model endpoint experiences consecutive timeouts opening circuit breaker", async () => {
    const primaryBreaker = getModelCircuitBreaker(PRIMARY_MODEL, {
      failureThreshold: 2,
      resetTimeoutMs: 30000,
    });

    // Simulate primary provider failing repeatedly with timeout
    const timeoutErr = new Error("Model inference timed out after 15000ms");
    timeoutErr.name = "TimeoutError";

    streamGeneratorMock.mockImplementation(async function* () {
      primaryBreaker.trip();
      throw timeoutErr;
    });

    const response = await callEndpoint();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await readStreamEvents(response);
    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("error");
    expect(String(lastEvent.message)).toMatch(/timed out/i);
    expect(primaryBreaker.getState()).toBe(CircuitState.OPEN);
  });

  it("gracefully falls back when primary circuit is OPEN and secondary fallback completes successfully", async () => {
    tripModelCircuitBreaker(PRIMARY_MODEL);
    const primaryBreaker = getModelCircuitBreaker(PRIMARY_MODEL);
    expect(primaryBreaker.getState()).toBe(CircuitState.OPEN);

    // Flow handles model fallback and yields stream from fallback model
    streamGeneratorMock.mockImplementation(async function* () {
      yield { type: "chunk", explanation: "Analyzed via fallback resilient model." };
      yield {
        type: "done",
        result: {
          explanation: "Analyzed via fallback resilient model.",
          remediationSuggestions: "Sanitize input without eval.",
          promptInjectionSuspected: false,
        },
      };
    });

    const response = await callEndpoint();
    expect(response.status).toBe(200);

    const events = await readStreamEvents(response);
    expect(events).toEqual([
      { type: "chunk", explanation: "Analyzed via fallback resilient model." },
      {
        type: "done",
        result: {
          explanation: "Analyzed via fallback resilient model.",
          remediationSuggestions: "Sanitize input without eval.",
          promptInjectionSuspected: false,
        },
      },
    ]);

    expect(findingUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "finding-breaker-1" },
        data: expect.objectContaining({
          explanation: "Analyzed via fallback resilient model.",
        }),
      }),
    );
  });

  it("handles catastrophic multi-provider outage when both primary and secondary circuits trip", async () => {
    tripModelCircuitBreaker(PRIMARY_MODEL);
    tripModelCircuitBreaker(FALLBACK_MODEL);

    streamGeneratorMock.mockImplementation(async function* () {
      const err = new Error(
        "All AI inference providers unavailable (Groq and local circuits OPEN)",
      );
      err.name = "CircuitBreakerError";
      throw err;
    });

    const response = await callEndpoint();
    expect(response.status).toBe(200);

    const events = await readStreamEvents(response);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      type: "error",
      message: expect.stringMatching(/circuits OPEN|unavailable/i),
    });
    // Finding is NOT updated on error
    expect(findingUpdateMock).not.toHaveBeenCalled();
  });

  it("does not crash stream and scrubs sensitive credentials when provider error exposes internal token", async () => {
    streamGeneratorMock.mockImplementation(async function* () {
      throw new Error("Failed to connect with secret key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    });

    const response = await callEndpoint();
    const events = await readStreamEvents(response);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    // Ensure sensitive pattern was scrubbed by scrubSensitiveData
    expect(String(events[0].message)).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
  });
});
