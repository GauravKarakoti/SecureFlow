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
  checkRateLimitMock,
  findingFindFirstMock,
  findingUpdateMock,
  aiExplanationMock,
  generateBriefMock,
  getCacheKeyMock,
  getCachedAudioMock,
  setCachedAudioMock,
  fetchElevenLabsMock,
  createFallbackAudioMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findingFindFirstMock: vi.fn(),
  findingUpdateMock: vi.fn(),
  aiExplanationMock: vi.fn(),
  generateBriefMock: vi.fn(),
  getCacheKeyMock: vi.fn(),
  getCachedAudioMock: vi.fn(),
  setCachedAudioMock: vi.fn(),
  fetchElevenLabsMock: vi.fn(),
  createFallbackAudioMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return {
    ...actual,
    checkRateLimitDetailed: checkRateLimitMock,
    redis: { client: true }, // Add mock redis client if required by shared breaker store
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: {
      findFirst: findingFindFirstMock,
      update: findingUpdateMock,
    },
  },
}));

vi.mock("@/ai/flows/developer-receives-ai-security-explanations", () => ({
  developerReceivesAISecurityExplanations: aiExplanationMock,
}));

vi.mock("@/lib/findings/audio-debrief", () => ({
  generateAuditoryBrief: generateBriefMock,
  getAudioDebriefCacheKey: getCacheKeyMock,
  getCachedAudioDebrief: getCachedAudioMock,
  setCachedAudioDebrief: setCachedAudioMock,
  fetchElevenLabsAudioStream: fetchElevenLabsMock,
  createFallbackAudioBuffer: createFallbackAudioMock,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: {
    AI_STREAM: { limit: 20, windowSeconds: 60, fallbackStrategy: "fail-closed" },
    AI_STREAM_USER: {
      limit: 10,
      windowSeconds: 60,
      fallbackStrategy: "fail-closed",
      timeoutMs: 1000,
    },
  },
  withRateLimit: <T>(handler: T): T => handler,
}));

import { GET, POST } from "./route";

const mockFindingWithoutExplanation = {
  id: "finding-audio-breaker-1",
  type: "SECRET",
  severity: "CRITICAL",
  fileLocation: ".env",
  codeSnippet: "AWS_SECRET_ACCESS_KEY=1234567890",
  explanation: null,
  remediation: null,
};

const mockFindingWithExplanation = {
  id: "finding-audio-breaker-2",
  type: "VULNERABILITY",
  severity: "HIGH",
  fileLocation: "src/server.ts",
  codeSnippet: "child_process.exec(userInput)",
  explanation: "Command injection allows remote code execution.",
  remediation: "Use execFile with argument array.",
};

describe("GET /api/findings/[id]/audio-debrief - Circuit Breaker & Provider Outage Resilience (#1553)", () => {
  const LLM_MODEL = "groq/openai/gpt-oss-20b";
  const ELEVENLABS_CIRCUIT = "elevenlabs/tts";

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    delete process.env.ELEVENLABS_API_KEY;

    authMock.mockResolvedValue({ user: { id: "user-audio-1" } });
    checkRateLimitMock.mockResolvedValue(true);
    generateBriefMock.mockReturnValue("Auditory brief text for security finding");
    getCacheKeyMock.mockReturnValue("cache-key-audio-breaker");
    getCachedAudioMock.mockResolvedValue(null);
    findingUpdateMock.mockReturnValue({ catch: vi.fn() });
    createFallbackAudioMock.mockReturnValue(Buffer.from("ID3-MOCK-FALLBACK-AUDIO-DATA"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
    vi.restoreAllMocks();
  });

  it("gracefully falls back to auditory brief synthesis when Groq LLM circuit breaker is OPEN", async () => {
    tripModelCircuitBreaker(LLM_MODEL);
    const breaker = getModelCircuitBreaker(LLM_MODEL);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    findingFindFirstMock.mockResolvedValue(mockFindingWithoutExplanation);
    aiExplanationMock.mockRejectedValue(
      new Error("Circuit breaker is OPEN for model " + LLM_MODEL),
    );

    const req = new NextRequest(
      "http://localhost/api/findings/finding-audio-breaker-1/audio-debrief",
    );
    const response = await GET(req, {
      params: Promise.resolve({ id: "finding-audio-breaker-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Audio-Cache")).toBe("FALLBACK");
    // Auditory brief generator should still receive metadata even when LLM explanation failed
    expect(generateBriefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        findingType: "SECRET",
        severity: "CRITICAL",
        fileLocation: ".env",
        explanation: null,
      }),
    );
  });

  it("handles Groq timeout during on-demand explanation generation and still synthesizes brief", async () => {
    const breaker = getModelCircuitBreaker(LLM_MODEL, { failureThreshold: 1 });
    findingFindFirstMock.mockResolvedValue(mockFindingWithoutExplanation);

    const timeoutError = new Error("Model inference timed out after 15000ms");
    timeoutError.name = "TimeoutError";
    aiExplanationMock.mockImplementation(async () => {
      breaker.trip();
      throw timeoutError;
    });

    const req = new NextRequest(
      "http://localhost/api/findings/finding-audio-breaker-1/audio-debrief",
    );
    const response = await GET(req, {
      params: Promise.resolve({ id: "finding-audio-breaker-1" }),
    });

    expect(response.status).toBe(200);
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(createFallbackAudioMock).toHaveBeenCalled();
  });

  it("serves cache immediately without invoking circuit-broken upstream TTS or LLM", async () => {
    tripModelCircuitBreaker(LLM_MODEL);
    tripModelCircuitBreaker(ELEVENLABS_CIRCUIT);

    findingFindFirstMock.mockResolvedValue(mockFindingWithExplanation);
    const cachedBuffer = Buffer.from("ID3-MOCK-CACHED-AUDIO-DATA");
    getCachedAudioMock.mockResolvedValue(cachedBuffer);

    const req = new NextRequest(
      "http://localhost/api/findings/finding-audio-breaker-2/audio-debrief",
    );
    const response = await GET(req, {
      params: Promise.resolve({ id: "finding-audio-breaker-2" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Audio-Cache")).toBe("HIT");
    expect(response.headers.get("ETag")).toBe('"cache-key-audio-breaker"');
    expect(fetchElevenLabsMock).not.toHaveBeenCalled();
    expect(aiExplanationMock).not.toHaveBeenCalled();
  });

  it("returns fallback playable buffer when ElevenLabs upstream times out or returns 504", async () => {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
    findingFindFirstMock.mockResolvedValue(mockFindingWithExplanation);

    const gatewayTimeout = new Error("Upstream 504 Gateway Timeout from ElevenLabs");
    (gatewayTimeout as any).status = 504;
    fetchElevenLabsMock.mockRejectedValue(gatewayTimeout);

    const req = new NextRequest(
      "http://localhost/api/findings/finding-audio-breaker-2/audio-debrief",
    );
    const response = await GET(req, {
      params: Promise.resolve({ id: "finding-audio-breaker-2" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Audio-Cache")).toBe("FALLBACK");
    expect(createFallbackAudioMock).toHaveBeenCalled();
  });

  it("returns 502 Bad Gateway when Accept is application/json and upstream TTS fails under open breaker", async () => {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
    findingFindFirstMock.mockResolvedValue(mockFindingWithExplanation);
    fetchElevenLabsMock.mockRejectedValue(new Error("Circuit breaker is OPEN for elevenlabs/tts"));

    const req = new NextRequest(
      "http://localhost/api/findings/finding-audio-breaker-2/audio-debrief",
      {
        headers: { Accept: "application/json" },
      },
    );
    const response = await GET(req, {
      params: Promise.resolve({ id: "finding-audio-breaker-2" }),
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      error: "Bad Gateway",
      message: "Failed to generate audio stream from upstream ElevenLabs service.",
    });
  });

  it("mirrors identical resilience behavior for POST method", async () => {
    tripModelCircuitBreaker(LLM_MODEL);
    findingFindFirstMock.mockResolvedValue(mockFindingWithExplanation);
    fetchElevenLabsMock.mockRejectedValue(new Error("Service unavailable"));

    const req = new NextRequest(
      "http://localhost/api/findings/finding-audio-breaker-2/audio-debrief",
      {
        method: "POST",
      },
    );
    const response = await POST(req, {
      params: Promise.resolve({ id: "finding-audio-breaker-2" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Audio-Cache")).toBe("FALLBACK");
  });
});
