import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("genkit", async () => {
  const { z } = await import("zod");
  return { genkit: vi.fn(() => ({})), z };
});
vi.mock("@genkit-ai/compat-oai", () => ({ openAICompatible: vi.fn(() => ({})) }));

const { mockGenerateStream, PRIMARY, SMALL, TINY } = vi.hoisted(() => ({
  mockGenerateStream: vi.fn(),
  PRIMARY: "openai/llama3",
  SMALL: "openai/llama3.2:3b",
  TINY: "openai/llama3.2:1b",
}));

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generateStream: mockGenerateStream })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
  ai: { generateStream: mockGenerateStream },
  securityExplanationModel: PRIMARY,
  getSecurityExplanationModelChain: vi.fn(() => [PRIMARY, SMALL]),
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
import { insufficientVramMessage } from "@/ai/local-model";
import {
  VRAMConcurrencyError,
  resetLocalModelSemaphore,
  resetModelCircuitBreakers,
} from "@/ai/resilience";

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

describe("streamDeveloperSecurityExplanations - Insufficient VRAM (#1586, #1950)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    mockGetCached.mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    vi.restoreAllMocks();
  });

  it("switches to the smaller local model without retrying OOM and without caching fallback output", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue([PRIMARY, SMALL, TINY]);

    mockGenerateStream.mockImplementation(({ model }: { model: string }) => {
      if (model === PRIMARY) return failingGenkitStream(OOM_ERROR);
      if (model === SMALL) return failingGenkitStream(new VRAMConcurrencyError());
      return genkitStream(
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
      );
    });

    const events = await collect(streamDeveloperSecurityExplanations(sampleInput));

    const calledModels = mockGenerateStream.mock.calls.map(([opts]) => opts.model);
    expect(calledModels).toEqual([PRIMARY, SMALL, TINY]);
    for (const modelRef of calledModels) {
      expect(String(modelRef)).toMatch(/^openai\//);
      expect(String(modelRef)).not.toMatch(/^groq\//);
    }
    expect(mockSetCached).not.toHaveBeenCalled();

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.result.explanation).toContain("Compact local model");
    }
  });

  it("yields actionable InsufficientVRAMError without stack traces when all local models OOM", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue([PRIMARY, SMALL]);

    mockGenerateStream.mockImplementation(() => failingGenkitStream(OOM_ERROR));

    const events = await collect(streamDeveloperSecurityExplanations(sampleInput));

    expect(mockGenerateStream).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      {
        type: "error",
        message: insufficientVramMessage([PRIMARY, SMALL]),
      },
    ]);
    if (events[0].type === "error") {
      expect(events[0].message).not.toMatch(/\n\s+at /);
      expect(events[0].message).toContain("LOCAL_AI_FALLBACK_MODELS");
    }
    expect(mockSetCached).not.toHaveBeenCalled();
  });
});
