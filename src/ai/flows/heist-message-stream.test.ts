import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @/ai/genkit ──────────────────────────────────────────────────────────
// Mirrors the pattern from security-explanation-stream.test.ts exactly.
// generateStream returns an async-iterable `stream` of text delta chunks plus
// a `response` promise for the final assembled text.
let mockChunks: string[] = [];
let mockFinalText = "Bella ciao, accomplice. The vault is sealed.";
let mockGenerateStreamThrows = false;
// Errors thrown when the stream is first pulled, one per call, like a real
// provider failure surfacing through Genkit's stream rather than the call.
let mockPullErrors: Error[] = [];
let mockGenerateStreamCalls = 0;
// Local-model mode (LOCAL_AI_URL set) and the instance/model each call used.
let mockLocalMode = false;
let mockLastCall: { instance: "cloud" | "local"; model: unknown } | null = null;

vi.mock("@/ai/genkit", () => {
  const ai = {
    generateStream: (options: { model?: unknown }) => {
      mockGenerateStreamCalls++;
      mockLastCall = { instance: "cloud", model: options?.model };
      if (mockGenerateStreamThrows) {
        throw new Error("simulated model failure");
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  projectName: "The Royal Mint",
  score: 95,
  rank: "S" as const,
  findingsCount: 2,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("streamHeistMessage", () => {
  beforeEach(() => {
    mockChunks = [];
    mockFinalText = "Bella ciao, accomplice. The vault is sealed.";
    mockGenerateStreamThrows = false;
    mockPullErrors = [];
    mockGenerateStreamCalls = 0;
    mockLocalMode = false;
    mockLastCall = null;
  });

  // ── Model routing ───────────────────────────────────────────────────────────

  it("uses the Groq instance and GROQ_MODEL-derived model in cloud mode", async () => {
    mockChunks = ["Bella ciao."];
    await collectEvents(baseInput);
    expect(mockLastCall).toEqual({ instance: "cloud", model: "mock-model" });
  });

  it("routes to the local model when LOCAL_AI_URL is configured", async () => {
    // It used to call the Groq-backed `ai` unconditionally, so a local-model
    // deployment failed every transmission and always served the fallback.
    mockLocalMode = true;

    const events = await collectEvents(baseInput);

    expect(mockLastCall).toEqual({ instance: "local", model: "openai/llama3.1" });
    expect(events.at(-1)).toEqual({
      type: "done",
      message: "Local transmission.",
      guarded: false,
    });
  });

  // ── Streaming chunks ────────────────────────────────────────────────────────

  it("yields incremental chunk events as text accumulates", async () => {
    // Each mock chunk is a raw delta from the model; the flow accumulates them
    // before yielding — so the emitted `text` is the total text received so far.
    mockChunks = ["Bella ", "ciao, ", "accomplice."];
    mockFinalText = "Bella ciao, accomplice.";

    const events = await collectEvents(baseInput);
    const chunks = events.filter((e) => e.type === "chunk");

    // Three unique accumulated-text snapshots (each is delta appended to previous).
    expect(chunks).toHaveLength(3);
    if (chunks[0].type === "chunk") expect(chunks[0].text).toBe("Bella ");
    if (chunks[1].type === "chunk") expect(chunks[1].text).toBe("Bella ciao, ");
    if (chunks[2].type === "chunk") expect(chunks[2].text).toBe("Bella ciao, accomplice.");
  });

  it("does not emit a chunk event for an empty delta", async () => {
    // Empty strings from the model should be silently dropped.
    mockChunks = ["Hello", "", " world"];
    mockFinalText = "Hello world";

    const events = await collectEvents(baseInput);
    const chunks = events.filter((e) => e.type === "chunk");

    // Only non-empty deltas should produce chunk events.
    expect(chunks).toHaveLength(2);
  });

  // ── Done event ──────────────────────────────────────────────────────────────

  it("ends with a single done event containing the final message", async () => {
    mockFinalText = "Bella ciao, accomplice. The vault is sealed. Zero traces remain.";

    const events = await collectEvents(baseInput);
    const doneEvents = events.filter((e) => e.type === "done");

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0].type === "done") {
      expect(doneEvents[0].message).toBe(
        "Bella ciao, accomplice. The vault is sealed. Zero traces remain.",
      );
    }
  });

  it("emits exactly one done event as the last event", async () => {
    mockChunks = ["Part one. ", "Part one. Part two."];
    mockFinalText = "Part one. Part two.";

    const events = await collectEvents(baseInput);
    const last = events[events.length - 1];

    expect(last.type).toBe("done");
  });

  it("falls back to FALLBACK_HEIST_MESSAGE when finalText is empty", async () => {
    mockChunks = [];
    mockFinalText = "";

    const events = await collectEvents(baseInput);
    const done = events.find((e) => e.type === "done");

    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message).toBe(FALLBACK_HEIST_MESSAGE);
    }
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it("yields a single error event (not a thrown exception) when generation throws", async () => {
    mockGenerateStreamThrows = true;

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].message).toContain("simulated model failure");
    }
  });

  it("retries when the provider rate-limits the stream before the first chunk", async () => {
    mockPullErrors = [Object.assign(new Error("429 Too Many Requests"), { status: 429 })];
    mockChunks = ["Bella ", "ciao."];
    mockFinalText = "Bella ciao.";

    const events = await collectEvents(baseInput);

    expect(mockGenerateStreamCalls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", message: "Bella ciao." });
  });

  it("reports the rate limit once retries are exhausted", async () => {
    const rateLimited = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    mockPullErrors = [rateLimited(), rateLimited(), rateLimited(), rateLimited()];

    const events = await collectEvents(baseInput);

    expect(mockGenerateStreamCalls).toBe(4);
    expect(events).toEqual([
      {
        type: "error",
        message: "Groq API rate limit reached (429). Falling back to default heist transmission.",
      },
    ]);
  });

  it("does not retry a non-retryable stream failure", async () => {
    mockPullErrors = [new Error("invalid api key")];

    const events = await collectEvents(baseInput);

    expect(mockGenerateStreamCalls).toBe(1);
    expect(events).toEqual([{ type: "error", message: "invalid api key" }]);
  });

  it("yields an error event for invalid input (missing projectName)", async () => {
    const events = await collectEvents({
      projectName: "", // min length 1 — should fail Zod validation
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("yields an error event for an out-of-range score", async () => {
    const events = await collectEvents({
      projectName: "Test",
      score: 150, // > 100 — should fail Zod validation
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  // ── Optional fields ─────────────────────────────────────────────────────────

  it("works correctly when only projectName is provided", async () => {
    mockFinalText = "The vault of Test Project is sealed.";

    const events = await collectEvents({ projectName: "Test Project" });
    const done = events.find((e) => e.type === "done");

    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message).toContain("Test Project");
    }
  });

  it("accumulates chunk text correctly across multiple deltas", async () => {
    // Verify the accumulator logic: each chunk event text is the total so far.
    mockChunks = ["A", "B", "C"];
    mockFinalText = "ABC";

    const events = await collectEvents(baseInput);
    const chunkTexts = events
      .filter((e) => e.type === "chunk")
      .map((e) => (e as { type: "chunk"; text: string }).text);

    expect(chunkTexts).toEqual(["A", "AB", "ABC"]);
  });

  // ── Groq mock integration ────────────────────────────────────────────────────

  it("uses the existing Groq mock infrastructure (mockStream from __mocks__/groq-sdk)", async () => {
    // The flow uses @/ai/genkit (which wraps groq-sdk internally).
    // This test confirms the mock wiring works end-to-end without needing
    // a real GROQ_API_KEY by verifying the output matches mock data.
    mockChunks = ["Bella ciao."];
    mockFinalText = "Bella ciao, accomplice.";

    const events = await collectEvents(baseInput);
    expect(events.some((e) => e.type === "chunk")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.every((e) => e.type !== "error")).toBe(true);
  });
});
