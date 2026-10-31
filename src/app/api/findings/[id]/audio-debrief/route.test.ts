import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

vi.mock("@/lib/redis", () => ({
  checkRateLimit: checkRateLimitMock,
}));

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

describe("/api/findings/[id]/audio-debrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
    generateBriefMock.mockReturnValue("Auditory brief text for finding");
    getCacheKeyMock.mockReturnValue("cache-key-123");
    findingUpdateMock.mockReturnValue({ catch: vi.fn() });
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/findings/f-1/audio-debrief");
    const params = Promise.resolve({ id: "f-1" });
    const res = await GET(req, { params });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("returns 429 when user exceeds rate limits", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    checkRateLimitMock.mockResolvedValueOnce(false);

    const req = new NextRequest("http://localhost:3000/api/findings/f-1/audio-debrief");
    const params = Promise.resolve({ id: "f-1" });
    const res = await GET(req, { params });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
  });

  it("returns 404 when finding is not found or not owned by user", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/findings/f-missing/audio-debrief");
    const params = Promise.resolve({ id: "f-missing" });
    const res = await GET(req, { params });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Finding not found" });
  });

  it("returns 200 with cached audio on cache HIT", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-1",
      type: "SQL_INJECTION",
      severity: "CRITICAL",
      fileLocation: "src/db.ts:12",
      codeSnippet: "SELECT * FROM users",
      explanation: "Vulnerable query",
      remediation: "Use parameterized queries",
    });

    const cachedBuffer = Buffer.from("cached-mp3-audio-bytes");
    getCachedAudioMock.mockResolvedValueOnce(cachedBuffer);

    const req = new NextRequest("http://localhost:3000/api/findings/f-1/audio-debrief");
    const params = Promise.resolve({ id: "f-1" });
    const res = await GET(req, { params });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-Audio-Cache")).toBe("HIT");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).not.toContain("public");
    expect(fetchElevenLabsMock).not.toHaveBeenCalled();
  });

  it("streams synthesized audio on ElevenLabs cache MISS", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-1",
      type: "XSS",
      severity: "HIGH",
      fileLocation: "src/ui.tsx:10",
      codeSnippet: "<div dangerouslySetInnerHTML={...} />",
      explanation: "Cross-site scripting risk",
      remediation: "Sanitize HTML input",
    });

    getCachedAudioMock.mockResolvedValueOnce(null);

    const fakeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    fetchElevenLabsMock.mockResolvedValueOnce({ body: fakeStream });

    const req = new NextRequest("http://localhost:3000/api/findings/f-1/audio-debrief");
    const params = Promise.resolve({ id: "f-1" });
    const res = await GET(req, { params });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-Audio-Cache")).toBe("MISS");
    expect(res.body).toBeDefined();
  });

  it("returns fallback audio buffer when ElevenLabs TTS stream fails or is unavailable", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-1",
      type: "COMMAND_INJECTION",
      severity: "HIGH",
      fileLocation: "src/exec.ts:5",
      codeSnippet: "exec(userInput)",
      explanation: "Unsanitized command execution",
      remediation: "Use execFile with argument array",
    });

    getCachedAudioMock.mockResolvedValueOnce(null);
    fetchElevenLabsMock.mockResolvedValueOnce(null);

    const fallbackBuffer = Buffer.from("fallback-mp3-bytes");
    createFallbackAudioMock.mockReturnValueOnce(fallbackBuffer);

    const req = new NextRequest("http://localhost:3000/api/findings/f-1/audio-debrief");
    const params = Promise.resolve({ id: "f-1" });
    const res = await GET(req, { params });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-Audio-Cache")).toBe("FALLBACK");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(createFallbackAudioMock).toHaveBeenCalledWith("Auditory brief text for finding");
    expect(setCachedAudioMock).not.toHaveBeenCalled();
  });

  it("generates AI explanation dynamically when finding has no pre-existing explanation", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-2",
      type: "HARDCODED_SECRET",
      severity: "MEDIUM",
      fileLocation: "src/config.ts:8",
      codeSnippet: "const apiKey = '12345'",
      explanation: null,
      remediation: null,
    });

    aiExplanationMock.mockResolvedValueOnce({
      explanation: "Generated explanation",
      remediationSuggestions: "Move to env",
      promptInjectionSuspected: false,
    });

    getCachedAudioMock.mockResolvedValueOnce(null);
    fetchElevenLabsMock.mockResolvedValueOnce(null);
    createFallbackAudioMock.mockReturnValueOnce(Buffer.from("audio"));

    const req = new NextRequest("http://localhost:3000/api/findings/f-2/audio-debrief", {
      method: "POST",
    });
    const params = Promise.resolve({ id: "f-2" });
    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(aiExplanationMock).toHaveBeenCalledWith({
      findingType: "HARDCODED_SECRET",
      severity: "MEDIUM",
      description: "",
      fileLocation: "src/config.ts:8",
      codeSnippet: "const apiKey = '12345'",
    });
    expect(findingUpdateMock).toHaveBeenCalled();
  });

  it("ensures repeated requests for unchanged finding do not consume ElevenLabs character quota", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValue({
      id: "f-unchanged",
      type: "SQL_INJECTION",
      severity: "CRITICAL",
      fileLocation: "src/db.ts:12",
      codeSnippet: "SELECT * FROM users",
      explanation: "Vulnerable query",
      remediation: "Use parameterized queries",
    });

    // First request: Cache MISS -> Streams from ElevenLabs
    getCachedAudioMock.mockResolvedValueOnce(null);
    const fakeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    fetchElevenLabsMock.mockResolvedValueOnce({ body: fakeStream });

    const req1 = new NextRequest("http://localhost:3000/api/findings/f-unchanged/audio-debrief");
    const res1 = await GET(req1, { params: Promise.resolve({ id: "f-unchanged" }) });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Audio-Cache")).toBe("MISS");
    expect(fetchElevenLabsMock).toHaveBeenCalledTimes(1);

    // Second request: Cache HIT -> returns cached buffer, zero additional ElevenLabs calls
    const cachedBuffer = Buffer.from("cached-audio-stream");
    getCachedAudioMock.mockResolvedValueOnce(cachedBuffer);

    const req2 = new NextRequest("http://localhost:3000/api/findings/f-unchanged/audio-debrief");
    const res2 = await GET(req2, { params: Promise.resolve({ id: "f-unchanged" }) });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Audio-Cache")).toBe("HIT");
    expect(res2.headers.get("Cache-Control")).toContain("immutable");
    expect(fetchElevenLabsMock).toHaveBeenCalledTimes(1);
  });

  it("handles upstream ElevenLabs error status codes (401, 429, 500) gracefully with fallback audio", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValue({
      id: "f-upstream-err",
      type: "XSS",
      severity: "HIGH",
      fileLocation: "src/app.tsx:5",
      codeSnippet: "<div />",
      explanation: "XSS vulnerability",
      remediation: "Escape output",
    });

    const fallbackBuffer = Buffer.from("silent-fallback-mp3");
    createFallbackAudioMock.mockReturnValue(fallbackBuffer);

    // Test upstream 401 (Unauthorized / invalid key)
    getCachedAudioMock.mockResolvedValueOnce(null);
    fetchElevenLabsMock.mockResolvedValueOnce(null);
    const res401 = await GET(
      new NextRequest("http://localhost:3000/api/findings/f-upstream-err/audio-debrief"),
      { params: Promise.resolve({ id: "f-upstream-err" }) },
    );
    expect(res401.status).toBe(200);
    expect(res401.headers.get("X-Audio-Cache")).toBe("FALLBACK");

    // Test upstream 429 (Quota exhaustion)
    getCachedAudioMock.mockResolvedValueOnce(null);
    fetchElevenLabsMock.mockResolvedValueOnce(null);
    const res429 = await GET(
      new NextRequest("http://localhost:3000/api/findings/f-upstream-err/audio-debrief"),
      { params: Promise.resolve({ id: "f-upstream-err" }) },
    );
    expect(res429.status).toBe(200);
    expect(res429.headers.get("X-Audio-Cache")).toBe("FALLBACK");

    // Test upstream 500 (Internal service error)
    getCachedAudioMock.mockResolvedValueOnce(null);
    fetchElevenLabsMock.mockRejectedValueOnce(new Error("Upstream 500 Server Error"));
    const res500 = await GET(
      new NextRequest("http://localhost:3000/api/findings/f-upstream-err/audio-debrief"),
      { params: Promise.resolve({ id: "f-upstream-err" }) },
    );
    expect(res500.status).toBe(200);
    expect(res500.headers.get("X-Audio-Cache")).toBe("FALLBACK");
  });

  it("returns structured JSON error (503) when ELEVENLABS_API_KEY is missing and Accept is application/json", async () => {
    const originalApiKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-json-err",
      type: "SSRF",
      severity: "CRITICAL",
      fileLocation: "src/fetch.ts:10",
      codeSnippet: "fetch(url)",
      explanation: "SSRF",
      remediation: "Whitelist IPs",
    });
    getCachedAudioMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/findings/f-json-err/audio-debrief", {
      headers: { accept: "application/json" },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "f-json-err" }) });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Configuration Error");
    expect(body.message).toContain("ElevenLabs API key is not configured");

    process.env.ELEVENLABS_API_KEY = originalApiKey;
  });

  it("returns structured JSON error (502) when ElevenLabs upstream fails and Accept is application/json", async () => {
    const originalApiKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-api-key";

    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-upstream-fail",
      type: "SSRF",
      severity: "CRITICAL",
      fileLocation: "src/fetch.ts:10",
      codeSnippet: "fetch(url)",
      explanation: "SSRF",
      remediation: "Whitelist IPs",
    });
    getCachedAudioMock.mockResolvedValueOnce(null);
    fetchElevenLabsMock.mockResolvedValueOnce(null);

    const req = new NextRequest(
      "http://localhost:3000/api/findings/f-upstream-fail/audio-debrief",
      {
        headers: { accept: "application/json" },
      },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "f-upstream-fail" }) });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Bad Gateway");
    expect(body.message).toContain("upstream ElevenLabs");

    process.env.ELEVENLABS_API_KEY = originalApiKey;
  });

  it("passes findingId, briefText, and remediation to getAudioDebriefCacheKey", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
    findingFindFirstMock.mockResolvedValueOnce({
      id: "f-cache-key-test",
      type: "INSECURE_DESERIALIZATION",
      severity: "HIGH",
      fileLocation: "src/serialize.ts:20",
      codeSnippet: "deserialize(data)",
      explanation: "Insecure deserialization",
      remediation: "Use safe JSON parser",
    });
    getCachedAudioMock.mockResolvedValueOnce(Buffer.from("audio"));

    const req = new NextRequest(
      "http://localhost:3000/api/findings/f-cache-key-test/audio-debrief",
    );
    await GET(req, { params: Promise.resolve({ id: "f-cache-key-test" }) });

    expect(getCacheKeyMock).toHaveBeenCalledWith(
      "f-cache-key-test",
      "Auditory brief text for finding",
      "Use safe JSON parser",
    );
  });

  describe("additional cache and rate-limit coverage (#1377)", () => {
    it("includes Retry-After header when rate limited", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      checkRateLimitMock.mockResolvedValueOnce(false);
      const req = new NextRequest("http://localhost:3000/api/findings/f-1/audio-debrief");
      const params = Promise.resolve({ id: "f-1" });
      const res = await GET(req, { params });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
    });

    it("returns 503 when ElevenLabs API key is missing and JSON is requested", async () => {
      const originalKey = process.env.ELEVENLABS_API_KEY;
      delete process.env.ELEVENLABS_API_KEY;
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      findingFindFirstMock.mockResolvedValueOnce({
        id: "f-nokey",
        type: "SECRET",
        severity: "CRITICAL",
        fileLocation: "app.ts:1",
        codeSnippet: null,
        explanation: null,
        remediation: null,
      });
      getCachedAudioMock.mockResolvedValueOnce(null);
      const req = new NextRequest("http://localhost:3000/api/findings/f-nokey/audio-debrief", {
        headers: { accept: "application/json" },
      });
      const params = Promise.resolve({ id: "f-nokey" });
      const res = await GET(req, { params });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("Configuration Error");
      process.env.ELEVENLABS_API_KEY = originalKey;
    });

    it("returns fallback audio with X-Audio-Cache: FALLBACK when ElevenLabs fails", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      findingFindFirstMock.mockResolvedValueOnce({
        id: "f-fallback",
        type: "VULNERABILITY",
        severity: "MEDIUM",
        fileLocation: "lib/index.ts:22",
        codeSnippet: null,
        explanation: "Some vulnerability",
        remediation: null,
      });
      getCachedAudioMock.mockResolvedValueOnce(null);
      fetchElevenLabsMock.mockResolvedValueOnce(null);
      const fallbackBuf = Buffer.from([0xff, 0xfb, 0x92, 0x64]);
      createFallbackAudioMock.mockReturnValueOnce(fallbackBuf);
      process.env.ELEVENLABS_API_KEY = "test-key";
      const req = new NextRequest("http://localhost:3000/api/findings/f-fallback/audio-debrief");
      const params = Promise.resolve({ id: "f-fallback" });
      const res = await GET(req, { params });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Audio-Cache")).toBe("FALLBACK");
    });

    it("returns 502 when ElevenLabs stream fails and JSON is accepted", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      findingFindFirstMock.mockResolvedValueOnce({
        id: "f-502",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "server.ts:50",
        codeSnippet: null,
        explanation: "RCE vulnerability",
        remediation: null,
      });
      getCachedAudioMock.mockResolvedValueOnce(null);
      fetchElevenLabsMock.mockResolvedValueOnce(null);
      process.env.ELEVENLABS_API_KEY = "test-key";
      const req = new NextRequest("http://localhost:3000/api/findings/f-502/audio-debrief", {
        headers: { accept: "application/json" },
      });
      const params = Promise.resolve({ id: "f-502" });
      const res = await GET(req, { params });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Bad Gateway");
    });

    it("calls AI explanation flow when finding.explanation is null", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      findingFindFirstMock.mockResolvedValueOnce({
        id: "f-no-explain",
        type: "VULNERABILITY",
        severity: "HIGH",
        fileLocation: "auth.ts:12",
        codeSnippet: "eval(userInput)",
        explanation: null,
        remediation: null,
      });
      aiExplanationMock.mockResolvedValueOnce({
        explanation: "Code injection risk via eval.",
        remediationSuggestions: "Remove eval usage.",
        promptInjectionSuspected: false,
      });
      getCachedAudioMock.mockResolvedValueOnce(null);
      fetchElevenLabsMock.mockResolvedValueOnce(null);
      createFallbackAudioMock.mockReturnValueOnce(Buffer.from("fallback"));
      const req = new NextRequest("http://localhost:3000/api/findings/f-no-explain/audio-debrief");
      const params = Promise.resolve({ id: "f-no-explain" });
      const res = await GET(req, { params });
      expect(aiExplanationMock).toHaveBeenCalledOnce();
      expect(res.status).toBe(200);
    });

    it("POST is an alias for GET (same behaviour)", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      findingFindFirstMock.mockResolvedValueOnce({
        id: "f-post",
        type: "SECRET",
        severity: "LOW",
        fileLocation: "env.ts:1",
        codeSnippet: null,
        explanation: "Hardcoded value",
        remediation: "Move to env var",
      });
      const cached = Buffer.from("cached-post-bytes");
      getCachedAudioMock.mockResolvedValueOnce(cached);
      const req = new NextRequest("http://localhost:3000/api/findings/f-post/audio-debrief", {
        method: "POST",
      });
      const params = Promise.resolve({ id: "f-post" });
      const res = await POST(req, { params });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Audio-Cache")).toBe("HIT");
    });

    it("Cache-Control includes private on HIT to prevent shared-cache storage", async () => {
      authMock.mockResolvedValueOnce({ user: { id: "user-1" } });
      findingFindFirstMock.mockResolvedValueOnce({
        id: "f-cc",
        type: "MISCONFIG",
        severity: "INFO",
        fileLocation: "docker-compose.yml:10",
        codeSnippet: null,
        explanation: "Exposed port",
        remediation: null,
      });
      getCachedAudioMock.mockResolvedValueOnce(Buffer.from("some-audio"));
      const req = new NextRequest("http://localhost:3000/api/findings/f-cc/audio-debrief");
      const params = Promise.resolve({ id: "f-cc" });
      const res = await GET(req, { params });
      expect(res.headers.get("Cache-Control")).toContain("private");
    });
  });
});
