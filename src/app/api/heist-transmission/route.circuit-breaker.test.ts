import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  getModelCircuitBreaker,
  resetModelCircuitBreakers,
  tripModelCircuitBreaker,
  CircuitState,
} from "@/ai/resilience";

const streamHeistMessageMock = vi.fn();

vi.mock("@/ai/flows/heist-message-stream", () => ({
  streamHeistMessage: (...args: unknown[]) => streamHeistMessageMock(...args),
  FALLBACK_HEIST_MESSAGE: "Bella ciao, accomplice. Zero traces remain.",
}));

const { createHeistStream } = await import("./route");
const { resetTransmissionCache } = await import("@/lib/heist/transmission-cache");

const decoder = new TextDecoder();

async function readAllEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const events: Array<Record<string, unknown>> = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        try {
          events.push(JSON.parse(trimmed.slice(6)));
        } catch {}
      }
    }
  }

  return events;
}

describe("GET /api/heist-transmission - Circuit Breaker & Provider Outage Resilience (#1553)", () => {
  const HEIST_MODEL = "groq/openai/gpt-oss-20b";
  const LOCAL_HEIST_MODEL = "local/qwen2.5-coder-7b";

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    resetTransmissionCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
    resetTransmissionCache();
    vi.restoreAllMocks();
  });

  it("yields static fallback heist transmission when Groq AI provider circuit breaker is OPEN", async () => {
    tripModelCircuitBreaker(HEIST_MODEL);
    const breaker = getModelCircuitBreaker(HEIST_MODEL);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Generator throws CircuitBreakerError or timeout error
    streamHeistMessageMock.mockImplementation(async function* () {
      const err = new Error(`Circuit breaker is OPEN for model ${HEIST_MODEL}`);
      err.name = "CircuitBreakerError";
      throw err;
    });

    const stream = createHeistStream({ projectName: "vault-core", score: 98, rank: "S" });
    const events = await readAllEvents(stream);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(String(events[0].message)).toContain("Circuit breaker is OPEN");
  });

  it("gracefully streams fallback done message when generator exits early due to provider timeout", async () => {
    const breaker = getModelCircuitBreaker(HEIST_MODEL);

    streamHeistMessageMock.mockImplementation(async function* () {
      breaker.trip();
      // Simulating a stream that terminates prematurely due to timeout
      return;
    });

    const stream = createHeistStream({ projectName: "heist-plan" });
    const events = await readAllEvents(stream);

    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      type: "done",
      message: "Bella ciao, accomplice. Zero traces remain.",
    });
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it("recovers and serves from local memory transmission cache when subsequent requests arrive during provider outage", async () => {
    // 1. Initial successful stream caches transmission
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "chunk", text: "Vault secured." };
      yield { type: "done", message: "Vault secured.", guarded: false };
    });

    const firstStream = createHeistStream({ projectName: "royal-mint", score: 100 });
    const firstEvents = await readAllEvents(firstStream);
    expect(firstEvents).toEqual([
      { type: "chunk", text: "Vault secured." },
      { type: "done", message: "Vault secured.", guarded: false },
    ]);

    // 2. Now trip both cloud Groq and local model circuit breakers
    tripModelCircuitBreaker(HEIST_MODEL);
    tripModelCircuitBreaker(LOCAL_HEIST_MODEL);

    // 3. Second identical request hits transmission cache without touching provider
    const secondStream = createHeistStream({ projectName: "royal-mint", score: 100 });
    const secondEvents = await readAllEvents(secondStream);

    expect(secondEvents).toEqual([
      { type: "chunk", text: "Vault secured." },
      { type: "done", message: "Vault secured.", cached: true },
    ]);
    expect(streamHeistMessageMock).toHaveBeenCalledTimes(1);
  });

  it("scrubs internal connection credentials from error frames when AI endpoint error leaks environment variables", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      throw new Error(
        "Connection failed to https://api.groq.com with Bearer gsk_abc1234567890qwertyuiop",
      );
    });

    const stream = createHeistStream({ projectName: "payload-screen" });
    const events = await readAllEvents(stream);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(String(events[0].message)).not.toContain("gsk_abc1234567890qwertyuiop");
    expect(String(events[0].message)).toContain("[REDACTED_TOKEN]");
  });
});
