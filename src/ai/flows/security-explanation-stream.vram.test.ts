import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateStream } = vi.hoisted(() => ({
  mockGenerateStream: vi.fn(),
}));

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generateStream: mockGenerateStream })),
  getDefaultModelRef: vi.fn(() => "openai/llama3"),
  ai: { generateStream: mockGenerateStream },
  securityExplanationModel: "openai/llama3",
  getSecurityExplanationModelChain: vi.fn(() => ["openai/llama3", "openai/llama3.2:3b"]),
}));

vi.mock("../../database/vulnerabilityDb", () => ({
  getVulnerabilityMetadata: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/ai/local-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ai/local-model")>()),
  isLocalModelEnabled: vi.fn(() => true),
}));

vi.mock("dotenv/config", () => ({}));

const { mockGetCached, mockSetCached } = vi.hoisted(() => ({
  mockGetCached: vi.fn(),
  mockSetCached: vi.fn(),
}));

vi.mock("@/lib/explanation-cache", () => ({
  createExplanationCacheKey: vi.fn(() => "test-vram-cache-key"),
  getCachedExplanation: mockGetCached,
  setCachedExplanation: mockSetCached,
  getModelId: vi.fn((model: unknown) => String(model)),
}));

import {
  streamDeveloperSecurityExplanations,
  type StreamExplanationEvent,
} from "./security-explanation-stream";
import { getSecurityExplanationModelChain } from "@/ai/genkit";

function genkitStream(
  outputs: Array<Record<string, unknown>>,
  final: { output?: unknown; text?: string } = { output: null, text: "" },
) {
  return {
    stream: {
      [Symbol.asyncIterator]: async function* () {
        for (const output of outputs) yield { output };
      },
    },
    response: Promise.resolve(final),
  };
}

function failingGenkitStream(error: Error) {
  const response = Promise.reject(error);
  response.catch(() => {});
  return {
    stream: {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    },
    response,
  };
}

async function collect(
  gen: AsyncGenerator<StreamExplanationEvent, void, unknown>,
): Promise<StreamExplanationEvent[]> {
  const events: StreamExplanationEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const sampleInput = {
  findingType: "Path Traversal",
  severity: "CRITICAL" as const,
  fileLocation: "src/server/fileHandler.ts",
  codeSnippet: "fs.readFile(path.join(uploadDir, req.query.filename))",
  description: "User supplied filename is not validated against path traversal.",
};

const OOM_ERROR = new Error(
  "CUDA error: out of memory. Tried to allocate 4.2 GiB (GPU 0; 8.0 GiB total capacity)",
);

describe("streamDeveloperSecurityExplanations - Insufficient VRAM (#1586)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCached.mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("switches to the smaller local model when the primary model encounters insufficient VRAM", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue([
      "openai/llama3",
      "openai/llama3.2:3b",
    ]);

    mockGenerateStream.mockImplementation(({ model }: { model: string }) =>
      model === "openai/llama3"
        ? failingGenkitStream(OOM_ERROR)
        : genkitStream(
            [
              { explanation: "Compact local model: validate path." },
              { explanation: "Compact local model: validate path. Use path.basename." },
            ],
            {
              output: {
                explanation: "Compact local model: validate path. Use path.basename.",
                remediationSuggestions: "Sanitize directory paths.",
              },
            },
          ),
    );

    const events = await collect(streamDeveloperSecurityExplanations(sampleInput));

    expect(mockGenerateStream.mock.calls.map(([opts]) => opts.model)).toContain(
      "openai/llama3.2:3b",
    );
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.result.explanation).toContain("Compact local model");
    }
  });

  it("yields clear error message when all local models fail under memory pressure", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue(["openai/llama3"]);

    mockGenerateStream.mockImplementation(() => failingGenkitStream(OOM_ERROR));

    const events = await collect(streamDeveloperSecurityExplanations(sampleInput));

    expect(events).toEqual([
      {
        type: "error",
        message:
          'Not enough GPU memory to load local model "openai/llama3". Switch to a smaller model (for example LOCAL_AI_MODEL=llama3.2:3b) or list smaller ones in LOCAL_AI_FALLBACK_MODELS.',
      },
    ]);
  });
});
