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
  fetchElevenLabsMock,
  createFallbackAudioMock,
  getCachedAudioMock,
  setCachedAudioMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  fetchElevenLabsMock: vi.fn(),
  createFallbackAudioMock: vi.fn(),
  getCachedAudioMock: vi.fn(),
  setCachedAudioMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/findings/audio-debrief", () => ({
  fetchElevenLabsAudioStream: fetchElevenLabsMock,
  createFallbackAudioBuffer: createFallbackAudioMock,
  getCachedAudioDebrief: getCachedAudioMock,
  setCachedAudioDebrief: setCachedAudioMock,
}));

import { GET } from "./route";

function makeRequest(
  params: Record<string, string> = { repo: "acme/repo", decision: "BLOCK", severity: "CRITICAL" },
) {
  const url = new URL("http://localhost:3000/api/voice-alerts/audio");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe("GET /api/voice-alerts/audio - Circuit Breaker & Upstream Resilience (#1587)", () => {
  const VOICE_MODEL = "elevenlabs/voice-alert";

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();

    authMock.mockResolvedValue({ user: { id: "user-voice-breaker-1" } });
    getCachedAudioMock.mockResolvedValue(null);
    setCachedAudioMock.mockResolvedValue(undefined);
    createFallbackAudioMock.mockReturnValue(Buffer.from("FALLBACK_SILENT_MP3_BYTES"));

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
    vi.restoreAllMocks();
  });

  it("returns fallback silent MP3 when ElevenLabs circuit breaker is OPEN", async () => {
    tripModelCircuitBreaker(VOICE_MODEL);
    const breaker = getModelCircuitBreaker(VOICE_MODEL);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // When circuit is OPEN, upstream synthesis fails or returns null
    fetchElevenLabsMock.mockResolvedValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Cache")).toBe("FALLBACK");
    expect(createFallbackAudioMock).toHaveBeenCalled();
  });

  it("handles upstream synthesis network failure / timeout and falls back cleanly", async () => {
    const breaker = getModelCircuitBreaker(VOICE_MODEL, { failureThreshold: 2 });

    fetchElevenLabsMock.mockImplementation(async () => {
      breaker.trip();
      throw new Error("Upstream 504 Gateway Timeout from ElevenLabs");
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Cache")).toBe("FALLBACK");
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it("serves cached audio with X-Cache: HIT even when upstream circuit is OPEN", async () => {
    tripModelCircuitBreaker(VOICE_MODEL);
    const cachedBuffer = Buffer.from("CACHED_ALERT_MP3_DATA");
    getCachedAudioMock.mockResolvedValue(cachedBuffer);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Cache")).toBe("HIT");
    expect(fetchElevenLabsMock).not.toHaveBeenCalled();
  });

  it("recovers during HALF_OPEN probe: successful synthesis caches audio and returns X-Cache: MISS", async () => {
    const breaker = getModelCircuitBreaker(VOICE_MODEL, {
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });
    breaker.trip(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    const audioChunk = new Uint8Array([0xff, 0xfb, 0x90, 0x64]); // Plausible MP3 header
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(audioChunk);
        controller.close();
      },
    });

    const mockResponse = new Response(mockStream, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": "4",
      },
    });

    fetchElevenLabsMock.mockImplementation(async () => {
      breaker.reset();
      return mockResponse;
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Cache")).toBe("MISS");
    expect(setCachedAudioMock).toHaveBeenCalled();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it("returns 401 when request is unauthenticated before any breaker check", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(fetchElevenLabsMock).not.toHaveBeenCalled();
    expect(getCachedAudioMock).not.toHaveBeenCalled();
  });

  it("returns 400 when required query parameters are missing", async () => {
    const response = await GET(makeRequest({ repo: "acme/repo" })); // missing decision and severity

    expect(response.status).toBe(400);
    expect(fetchElevenLabsMock).not.toHaveBeenCalled();
  });
});
