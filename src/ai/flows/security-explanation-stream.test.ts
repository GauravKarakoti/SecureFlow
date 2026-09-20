import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that touch the mocked modules
// ---------------------------------------------------------------------------

const { mockGenerateStream } = vi.hoisted(() => ({
  mockGenerateStream: vi.fn(),
}));

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generateStream: mockGenerateStream })),
  getDefaultModelRef: vi.fn(() => "mock-model"),
  ai: { generateStream: mockGenerateStream },
  securityExplanationModel: "mock-security-model",
  getSecurityExplanationModelChain: vi.fn(() => ["mock-model"]),
}));

vi.mock("../../database/vulnerabilityDb", () => ({
  getVulnerabilityMetadata: vi.fn().mockResolvedValue(null),
}));

vi.mock("dotenv/config", () => ({}));

import { getAiInstance, getDefaultModelRef } from "@/ai/genkit";
import { getVulnerabilityMetadata } from "../../database/vulnerabilityDb";
import { streamSecurityExplanation } from "./security-explanation-stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAsyncIterable(chunks: string[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { text: c };
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateStream.mockResolvedValue({
    stream: makeAsyncIterable(["Hello ", "world."]),
    response: Promise.resolve({ output: null, text: "" }),
  });
});

// ---------------------------------------------------------------------------
// streamSecurityExplanation — local model routing
// ---------------------------------------------------------------------------

describe("streamSecurityExplanation — local model routing", () => {
  it("calls getAiInstance() so LOCAL_AI_URL is respected", async () => {
    const chunks: string[] = [];
    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "const x = eval(input);",
      onChunk: (c) => chunks.push(c),
    });

    expect(getAiInstance).toHaveBeenCalledOnce();
  });

  it("calls getDefaultModelRef() to resolve the active model", async () => {
    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "const x = eval(input);",
      onChunk: () => {},
    });

    expect(getDefaultModelRef).toHaveBeenCalledOnce();
  });

  it("passes the model from getDefaultModelRef to generateStream", async () => {
    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "const x = eval(input);",
      onChunk: () => {},
    });

    const callArgs = mockGenerateStream.mock.calls[0][0];
    expect(callArgs.model).toBe("mock-model");
  });

  it("does NOT instantiate a raw Groq client (no groq-sdk import)", async () => {
    // If the fix is correct, generateStream is called on the instance
    // returned by getAiInstance(), not on a raw Groq SDK client.
    // We verify this by confirming getAiInstance was called and
    // its generateStream was the one invoked.
    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "const x = eval(input);",
      onChunk: () => {},
    });

    expect(getAiInstance).toHaveBeenCalledOnce();
    expect(mockGenerateStream).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// streamSecurityExplanation — chunk delivery
// ---------------------------------------------------------------------------

describe("streamSecurityExplanation — chunk delivery", () => {
  it("calls onChunk for each text chunk from the stream", async () => {
    mockGenerateStream.mockResolvedValue({
      stream: makeAsyncIterable(["chunk1", "chunk2", "chunk3"]),
      response: Promise.resolve({ output: null, text: "" }),
    });

    const received: string[] = [];
    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "eval(input);",
      onChunk: (c) => received.push(c),
    });

    expect(received).toEqual(["chunk1", "chunk2", "chunk3"]);
  });

  it("skips empty chunks without calling onChunk", async () => {
    mockGenerateStream.mockResolvedValue({
      stream: makeAsyncIterable(["", "real chunk", ""]),
      response: Promise.resolve({ output: null, text: "" }),
    });

    const received: string[] = [];
    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "eval(input);",
      onChunk: (c) => received.push(c),
    });

    expect(received).toEqual(["real chunk"]);
  });

  it("includes vulnerability metadata in the prompt when available", async () => {
    vi.mocked(getVulnerabilityMetadata).mockResolvedValue({
      description: "Remote code execution via eval",
      cvss: "9.8",
    } as any);

    await streamSecurityExplanation({
      vulnerabilityId: "CVE-2024-001",
      sourceCode: "eval(input);",
      onChunk: () => {},
    });

    const callArgs = mockGenerateStream.mock.calls[0][0];
    expect(callArgs.prompt).toContain("Remote code execution via eval");
    expect(callArgs.prompt).toContain("9.8");
  });
});

// ---------------------------------------------------------------------------
// streamSecurityExplanation — error handling
// ---------------------------------------------------------------------------

describe("streamSecurityExplanation — error handling", () => {
  it("throws a wrapped error when generateStream rejects", async () => {
    mockGenerateStream.mockRejectedValue(new Error("model unavailable"));

    await expect(
      streamSecurityExplanation({
        vulnerabilityId: "CVE-2024-001",
        sourceCode: "eval(input);",
        onChunk: () => {},
      }),
    ).rejects.toThrow("Streaming pipeline encountered an internal execution fault.");
  });

  it("throws when the stream itself throws mid-iteration", async () => {
    mockGenerateStream.mockResolvedValue({
      stream: {
        [Symbol.asyncIterator]: async function* () {
          yield { text: "partial" };
          throw new Error("stream interrupted");
        },
      },
      response: Promise.resolve({ output: null, text: "" }),
    });

    await expect(
      streamSecurityExplanation({
        vulnerabilityId: "CVE-2024-001",
        sourceCode: "eval(input);",
        onChunk: () => {},
      }),
    ).rejects.toThrow("Streaming pipeline encountered an internal execution fault.");
  });
});
