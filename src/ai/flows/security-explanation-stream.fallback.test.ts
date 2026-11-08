import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateStream } = vi.hoisted(() => ({
  mockGenerateStream: vi.fn(),
}));

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generateStream: mockGenerateStream })),
  getDefaultModelRef: vi.fn(() => "mock-primary"),
  ai: { generateStream: mockGenerateStream },
  securityExplanationModel: "mock-primary",
  getSecurityExplanationModelChain: vi.fn(() => ["mock-primary", "mock-fallback"]),
}));

vi.mock("../../database/vulnerabilityDb", () => ({
  getVulnerabilityMetadata: vi.fn().mockResolvedValue(null),
}));

vi.mock("dotenv/config", () => ({}));

const { mockGetCached, mockSetCached } = vi.hoisted(() => ({
  mockGetCached: vi.fn(),
  mockSetCached: vi.fn(),
}));

vi.mock("@/lib/explanation-cache", () => ({
  createExplanationCacheKey: vi.fn(() => "test-cache-key"),
  getCachedExplanation: mockGetCached,
  setCachedExplanation: mockSetCached,
  getModelId: vi.fn((model: unknown) => String(model)),
}));

const mockRecordFallback = vi.fn();
vi.mock("@/lib/audit/ai-fallback-audit", () => ({
  recordAiFallbackEvent: (...args: unknown[]) => mockRecordFallback(...args),
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

const input = {
  findingType: "Cross-Site Scripting (XSS)",
  severity: "HIGH" as const,
  fileLocation: "src/components/UserProfile.tsx",
  codeSnippet: "<div dangerouslySetInnerHTML={{ __html: userBio }} />",
  description: "User supplied HTML is rendered directly into the DOM.",
};

describe("streamDeveloperSecurityExplanations - Fallback & Resilience (#1586)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCached.mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("falls back to secondary model when primary model hits rate limit (429)", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue(["mock-primary", "mock-fallback"]);

    const rateLimitError = Object.assign(new Error("429 Too Many Requests"), { status: 429 });

    mockGenerateStream.mockImplementation(({ model }: { model: string }) =>
      model === "mock-primary"
        ? failingGenkitStream(rateLimitError)
        : genkitStream(
            [
              { explanation: "Sanitize user inputs." },
              { explanation: "Sanitize user inputs. Use DOMPurify." },
            ],
            {
              output: {
                explanation: "Sanitize user inputs. Use DOMPurify.",
                remediationSuggestions: "Strip dangerous tags.",
              },
            },
          ),
    );

    const events = await collect(streamDeveloperSecurityExplanations(input));

    expect(mockGenerateStream.mock.calls.map(([opts]) => opts.model)).toContain("mock-fallback");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.result.explanation).toContain("Sanitize user inputs");
    }
  });

  it("retries on temporary timeout before succeeding", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue(["mock-primary"]);

    const timeoutError = Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" });

    mockGenerateStream
      .mockImplementationOnce(() => failingGenkitStream(timeoutError))
      .mockImplementation(() =>
        genkitStream([{ explanation: "Recovered on retry." }], {
          output: {
            explanation: "Recovered on retry.",
            remediationSuggestions: "Fix vulnerability.",
          },
        }),
      );

    const events = await collect(streamDeveloperSecurityExplanations(input));

    expect(mockGenerateStream).toHaveBeenCalledTimes(2);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.result.explanation).toBe("Recovered on retry.");
    }
  });

  it("yields error event when all fallback models in chain fail", async () => {
    vi.mocked(getSecurityExplanationModelChain).mockReturnValue(["mock-primary"]);

    const rateLimitError = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    mockGenerateStream.mockImplementation(() => failingGenkitStream(rateLimitError));

    const events = await collect(streamDeveloperSecurityExplanations(input));

    expect(events).toEqual([
      {
        type: "error",
        message: "AI provider rate limit reached (429). Please wait a moment and try again.",
      },
    ]);
  });
});
