import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @/ai/genkit ──────────────────────────────────────────────────────────
let mockChunks: string[] = [];
let mockFinalText = "Bella ciao, accomplice. The vault is sealed.";
let mockGenerateStreamThrows: Error | null = null;
let mockPullErrors: Error[] = [];
let mockGenerateStreamCalls = 0;
let mockLocalMode = false;
let mockLastCall: { instance: "cloud" | "local"; model: unknown } | null = null;

vi.mock("@/ai/genkit", () => {
  const ai = {
    generateStream: (options: { model?: unknown }) => {
      mockGenerateStreamCalls++;
      mockLastCall = { instance: "cloud", model: options?.model };
      if (mockGenerateStreamThrows) {
        throw mockGenerateStreamThrows;
      }
      const pullError = mockPullErrors.shift();
      if (pullError) {
        const response = Promise.reject(pullError);
        response.catch(() => {});
        return {
          stream: (async function* () {
            yield* [];
            throw pullError;
          })(),
          response,
        };
      }
      return {
        stream: (async function* () {
          for (const delta of mockChunks) {
            yield { text: delta };
          }
        })(),
        response: Promise.resolve({ text: mockFinalText }),
      };
    },
  };
  const localAi = {
    generateStream: (options: { model?: unknown }) => {
      mockGenerateStreamCalls++;
      mockLastCall = { instance: "local", model: options?.model };
      if (mockGenerateStreamThrows) {
        throw mockGenerateStreamThrows;
      }
      return {
        stream: (async function* () {
          yield { text: "Local transmission." };
        })(),
        response: Promise.resolve({ text: "Local transmission." }),
      };
    },
  };
  return {
    ai,
    getAiInstance: () => (mockLocalMode ? localAi : ai),
    isLocalModelEnabled: () => mockLocalMode,
    getDefaultModelRef: () => (mockLocalMode ? "openai/llama3.1" : "groq-pinned-ref"),
    DEFAULT_SECURITY_CONFIG: { modelName: "mock-model" },
  };
});

vi.mock("dotenv/config", () => ({}));

import {
  streamHeistMessage,
  FALLBACK_HEIST_MESSAGE,
  type HeistStreamEvent,
} from "./heist-message-stream";

async function collectEvents(
  input: Parameters<typeof streamHeistMessage>[0],
): Promise<HeistStreamEvent[]> {
  const events: HeistStreamEvent[] = [];
  for await (const event of streamHeistMessage(input)) {
    events.push(event);
  }
  return events;
}

const baseInput = {
  projectName: "Vault-Alpha",
  score: 85,
  rank: "A" as const,
  findingsCount: 1,
};

describe("streamHeistMessage - Provider Fallback & Outage Resilience (#1586)", () => {
  beforeEach(() => {
    mockChunks = [];
    mockFinalText = "Bella ciao, accomplice. The vault is sealed.";
    mockGenerateStreamThrows = null;
    mockPullErrors = [];
    mockGenerateStreamCalls = 0;
    mockLocalMode = false;
    mockLastCall = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("yields chunk and done events during successful streaming", async () => {
    mockChunks = ["Transmission verified. ", "The Professor observes zero leaks."];
    mockFinalText = "Transmission verified. The Professor observes zero leaks.";

    const events = await collectEvents(baseInput);

    expect(events.length).toBeGreaterThanOrEqual(2);
    const chunkEvents = events.filter((e) => e.type === "chunk");
    expect(chunkEvents.length).toBe(2);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.message).toBe("Transmission verified. The Professor observes zero leaks.");
      expect(doneEvent.guarded).toBe(false);
    }
  });

  it("handles rate limit (429) errors gracefully by yielding an error event with fallback message", async () => {
    const rateLimitError = Object.assign(new Error("rate limit exceeded (429)"), { status: 429 });
    mockGenerateStreamThrows = rateLimitError;

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "Groq API rate limit reached (429). Falling back to default heist transmission.",
    });
  });

  it("handles provider timeout errors gracefully by yielding a timeout fallback message", async () => {
    const timeoutError = Object.assign(new Error("Gateway timeout 504"), { code: "ETIMEDOUT" });
    mockGenerateStreamThrows = timeoutError;

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "Groq API connection timed out. Falling back to default heist transmission.",
    });
  });

  it("handles provider pull error encountered on the first chunk pull", async () => {
    const rateLimited = () =>
      Object.assign(new Error("Connection reset by peer (429)"), {
        status: 429,
      });
    mockPullErrors = [rateLimited(), rateLimited(), rateLimited(), rateLimited()];

    const events = await collectEvents(baseInput);

    expect(mockGenerateStreamCalls).toBe(4);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "Groq API rate limit reached (429). Falling back to default heist transmission.",
    });
  });

  it("handles generic provider outages by emitting sanitized error event", async () => {
    mockGenerateStreamThrows = new Error("Service Unavailable (503)");

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "Service Unavailable (503)",
    });
  });
});
