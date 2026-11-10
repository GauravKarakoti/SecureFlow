import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  getModelCircuitBreaker,
  resetModelCircuitBreakers,
  tripModelCircuitBreaker,
  CircuitState,
} from "@/ai/resilience";

const { authMock, findUniqueMock, subscribeVoiceAlertMock, checkRateLimitDetailedMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    findUniqueMock: vi.fn(),
    subscribeVoiceAlertMock: vi.fn(),
    checkRateLimitDetailedMock: vi.fn(),
  }));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return {
    ...actual,
    checkRateLimitDetailed: checkRateLimitDetailedMock,
    redis: { client: true }, // Add mock redis client if required by shared breaker store
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("@/lib/voice-alert-events", () => ({
  subscribeVoiceAlert: subscribeVoiceAlertMock,
}));

import { GET, VOICE_ALERT_HEARTBEAT_MS } from "./route";

describe("GET /api/voice-alerts/stream - Circuit Breaker & Provider Resilience (#1553)", () => {
  const VOICE_MODEL = "elevenlabs/voice-alert";
  const REDIS_BREAKER = "redis/voice-alerts";

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    checkRateLimitDetailedMock.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: Date.now() + 60000,
      degraded: false,
    });
    authMock.mockResolvedValue({ user: { id: "user-voice-breaker" } });
    findUniqueMock.mockResolvedValue({ voiceAlertsEnabled: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
    vi.restoreAllMocks();
  });

  it("maintains SSE stream connectivity with heartbeat when downstream audio synthesis provider circuit is OPEN", async () => {
    tripModelCircuitBreaker(VOICE_MODEL);
    const breaker = getModelCircuitBreaker(VOICE_MODEL);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    let eventCallback: ((event: unknown) => void) | null = null;
    subscribeVoiceAlertMock.mockImplementation((userId: string, cb: (event: unknown) => void) => {
      eventCallback = cb;
      return () => {};
    });

    const req = new NextRequest("http://localhost:3000/api/voice-alerts/stream");
    const response = await GET(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // First frame must be "connected"
    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toContain('"type":"connected"');

    // Simulate alert event coming through even while voice synthesis circuit is tripped
    eventCallback!({
      repositoryFullName: "acme/repo",
      prNumber: 42,
      decision: "BLOCK",
      topSeverity: "CRITICAL",
      alertId: "alert-123",
    });

    const secondChunk = await reader.read();
    const secondEvent = JSON.parse(
      decoder
        .decode(secondChunk.value)
        .replace(/^data: /, "")
        .trim(),
    );
    expect(secondEvent).toMatchObject({
      type: "voice-alert",
      repositoryFullName: "acme/repo",
      prNumber: 42,
      decision: "BLOCK",
      topSeverity: "CRITICAL",
    });

    reader.cancel();
  });

  it("handles rate limiting layer degradation gracefully when Redis circuit trips", async () => {
    const redisBreaker = getModelCircuitBreaker(REDIS_BREAKER, { failureThreshold: 1 });
    redisBreaker.trip();
    expect(redisBreaker.getState()).toBe(CircuitState.OPEN);

    // checkRateLimitDetailed degraded fail-open strategy
    checkRateLimitDetailedMock.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 1,
      resetAt: Date.now() + 60000,
      degraded: true,
    });

    const req = new NextRequest("http://localhost:3000/api/voice-alerts/stream");
    const response = await GET(req);

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunk = await reader.read();
    expect(decoder.decode(chunk.value)).toContain('"type":"connected"');
    reader.cancel();
  });

  it("cleans up subscriber without unhandled errors if subscriber emits error or closes during outage", async () => {
    const unsubscribeMock = vi.fn();
    subscribeVoiceAlertMock.mockImplementation(() => unsubscribeMock);

    const controller = new AbortController();
    const req = new NextRequest("http://localhost:3000/api/voice-alerts/stream", {
      signal: controller.signal,
    });

    const response = await GET(req);
    expect(response.status).toBe(200);

    // Abort request to simulate client disconnect or network drop
    controller.abort();
    expect(unsubscribeMock).toHaveBeenCalled();
  });
});
