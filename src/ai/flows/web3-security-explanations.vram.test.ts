import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("genkit", async () => {
  const { z } = await import("zod");
  return { genkit: vi.fn(() => ({})), z };
});
vi.mock("@genkit-ai/compat-oai", () => ({ openAICompatible: vi.fn(() => ({})) }));

const mockGenerate = vi.fn();
const mockGetChain = vi.fn();
const PRIMARY = "openai/llama3";
const FALLBACK_SMALL = "openai/llama3.2:3b";
const FALLBACK_TINY = "openai/llama3.2:1b";

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
  getSecurityExplanationModelChain: (...args: unknown[]) => mockGetChain(...args),
}));

// Local mode on; keep the real error helpers.
vi.mock("@/ai/local-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ai/local-model")>()),
  isLocalModelEnabled: vi.fn(() => true),
}));

const mockSetCached = vi.fn();
vi.mock("@/lib/explanation-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/explanation-cache")>()),
  getCachedExplanation: vi.fn(async () => null),
  setCachedExplanation: (...args: unknown[]) => mockSetCached(...args),
}));

vi.mock("dotenv/config", () => ({}));

import { web3SecurityExplanation } from "./web3-security-explanations";
import { insufficientVramMessage } from "@/ai/local-model";
import {
  VRAMConcurrencyError,
  resetLocalModelSemaphore,
  resetModelCircuitBreakers,
} from "@/ai/resilience";

const input = {
  findingType: "Under-constrained signal",
  severity: "Critical",
  fileLocation: "circuits/range.circom",
  codeSnippet: "signal output out; out <-- in * 2;",
  description: "Output signal is assigned but not constrained.",
};

const OOM = new Error("model requires more system memory (8.4 GiB) than is available (5.1 GiB)");
const CUDA_OOM = new Error("CUDA out of memory. Tried to allocate 2.00 GiB");

const goodReply = {
  text: '{"explanation":"Soundness bug: prover can pick any out.","remediationSuggestions":"Use <== to constrain the signal."}',
};

describe("web3SecurityExplanation - insufficient VRAM (#1525, #1950)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    mockGenerate.mockReset();
    mockSetCached.mockReset();
    mockGetChain.mockReset();
    mockGetChain.mockReturnValue([PRIMARY]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    vi.restoreAllMocks();
  });

  it("returns actionable InsufficientVRAMError guidance (not Signal lost) on OOM", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toBe(insufficientVramMessage([PRIMARY]));
    expect(result.explanation).toContain("LOCAL_AI_FALLBACK_MODELS");
    expect(result.explanation).not.toContain("Signal lost");
    expect(result.remediationSuggestions.length).toBeGreaterThan(0);
  });

  it("does not crash on a CUDA out-of-memory error", async () => {
    mockGenerate.mockRejectedValue(CUDA_OOM);

    const result = await web3SecurityExplanation(input);
    expect(result.explanation).toBe(insufficientVramMessage([PRIMARY]));
  });

  it("does not retry the same model on an out-of-memory error", async () => {
    mockGenerate.mockRejectedValue(OOM);

    await web3SecurityExplanation(input);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("returns a message without raw allocation numbers or a stack trace on OOM", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).not.toContain("GiB");
    expect(result.explanation).not.toMatch(/\n\s+at /);
    expect(result.remediationSuggestions).not.toMatch(/\n\s+at /);
  });

  it("never caches the fallback text produced after an OOM", async () => {
    mockGenerate.mockRejectedValue(OOM);

    await web3SecurityExplanation(input);

    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("falls back along local fallback chain on OOM and VRAMConcurrencyError without caching", async () => {
    mockGetChain.mockReturnValue([PRIMARY, FALLBACK_SMALL, FALLBACK_TINY]);

    mockGenerate
      .mockRejectedValueOnce(OOM)
      .mockRejectedValueOnce(new VRAMConcurrencyError())
      .mockResolvedValueOnce(goodReply);

    const result = await web3SecurityExplanation(input);

    const modelsCalled = mockGenerate.mock.calls.map((c) => c[0].model);
    expect(modelsCalled).toEqual([PRIMARY, FALLBACK_SMALL, FALLBACK_TINY]);
    for (const modelRef of modelsCalled) {
      expect(String(modelRef)).toMatch(/^openai\//);
      expect(String(modelRef)).not.toMatch(/^groq\//);
    }
    expect(result.explanation).toContain("Soundness");
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("names every local model tried when the entire chain fails with OOM", async () => {
    mockGetChain.mockReturnValue([PRIMARY, FALLBACK_SMALL, FALLBACK_TINY]);
    mockGenerate.mockRejectedValue(CUDA_OOM);

    const result = await web3SecurityExplanation(input);

    expect(mockGenerate).toHaveBeenCalledTimes(3);
    expect(result.explanation).toBe(
      insufficientVramMessage([PRIMARY, FALLBACK_SMALL, FALLBACK_TINY]),
    );
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("recovers on the next call once memory pressure is gone", async () => {
    mockGenerate.mockRejectedValue(OOM);
    await web3SecurityExplanation(input);

    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue(goodReply);
    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toContain("Soundness");
    expect(mockSetCached).toHaveBeenCalledTimes(1);
  });

  it("uses the ZK circuit prompt for .circom files even under memory pressure", async () => {
    mockGenerate.mockResolvedValue(goodReply);

    await web3SecurityExplanation(input);

    expect(mockGenerate.mock.calls[0][0].prompt).toContain("zero-knowledge circuit");
  });
});
