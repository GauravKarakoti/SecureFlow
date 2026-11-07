import { beforeEach, describe, expect, it, vi } from "vitest";

let mockChunks: string[] = [];
let mockFinalText = "Local transmission.";
let mockGenerateStreamThrows: Error | null = null;
let mockPullErrors: Error[] = [];
let mockGenerateStreamCalls = 0;
let mockLocalMode = true;
let mockLastCall: { instance: "cloud" | "local"; model: unknown } | null = null;

vi.mock("@/ai/genkit", () => {
  const localAi = {
    generateStream: (options: { model?: unknown }) => {
      mockGenerateStreamCalls++;
      mockLastCall = { instance: "local", model: options?.model };
      if (mockGenerateStreamThrows) {
        throw mockGenerateStreamThrows;
      }
      const pullError = mockPullErrors.shift();
      if (pullError) {
        const response = Promise.reject(pullError);
        response.catch(() => {});
        return {
          stream: {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(pullError),
            }),
          },
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
  return {
    ai: localAi,
    getAiInstance: () => localAi,
    isLocalModelEnabled: () => true,
    getDefaultModelRef: () => "openai/llama3.1",
    DEFAULT_SECURITY_CONFIG: { modelName: "openai/llama3.1" },
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
  projectName: "AirgappedVault",
  score: 92,
  rank: "S" as const,
  findingsCount: 0,
};

const OOM_ERROR = new Error(
  "CUDA error: out of memory. Tried to allocate 4.2 GiB (GPU 0; 8.0 GiB total capacity)",
);

describe("streamHeistMessage - Insufficient VRAM & Local Model Pressure (#1586)", () => {
  beforeEach(() => {
    mockChunks = [];
    mockFinalText = "Local transmission.";
    mockGenerateStreamThrows = null;
    mockPullErrors = [];
    mockGenerateStreamCalls = 0;
    mockLocalMode = true;
    mockLastCall = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("yields local stream chunks when local inference memory is sufficient", async () => {
    mockChunks = ["Airgapped stream chunk 1. ", "Zero egress confirmed."];
    mockFinalText = "Airgapped stream chunk 1. Zero egress confirmed.";

    const events = await collectEvents(baseInput);

    expect(mockLastCall).toEqual({ instance: "local", model: "openai/llama3.1" });
    const chunkEvents = events.filter((e) => e.type === "chunk");
    expect(chunkEvents).toHaveLength(2);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.message).toBe("Airgapped stream chunk 1. Zero egress confirmed.");
    }
  });

  it("handles CUDA out-of-memory errors by yielding an error event gracefully", async () => {
    mockGenerateStreamThrows = OOM_ERROR;

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: OOM_ERROR.message,
    });
  });

  it("handles VRAM memory pressure during mid-stream chunk pulling", async () => {
    mockPullErrors.push(new Error("CUDA out of memory: tensor allocation failure"));

    const events = await collectEvents(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: "CUDA out of memory: tensor allocation failure",
    });
  });
});
