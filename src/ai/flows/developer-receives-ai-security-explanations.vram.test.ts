import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("genkit", async () => {
  const { z } = await import("zod");
  return { genkit: vi.fn(() => ({})), z };
});
vi.mock("@genkit-ai/compat-oai", () => ({ openAICompatible: vi.fn(() => ({})) }));

const mockGenerate = vi.fn();
const mockGetChain = vi.fn();
const PRIMARY = "openai/llama3";
const SMALL = "openai/llama3.2:3b";
const TINY = "openai/llama3.2:1b";

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

import { developerReceivesAISecurityExplanations } from "./developer-receives-ai-security-explanations";
import { insufficientVramMessage } from "@/ai/local-model";
import {
  VRAMConcurrencyError,
  resetLocalModelSemaphore,
  resetModelCircuitBreakers,
} from "@/ai/resilience";

const input = {
  findingType: "SQL Injection",
  severity: "High",
  fileLocation: "src/db.ts",
  codeSnippet: 'db.query("SELECT * FROM u WHERE id=" + id)',
  description: "User input is concatenated into a SQL query.",
};

const OOM = new Error("model requires more system memory (8.4 GiB) than is available (5.1 GiB)");
const CUDA_OOM = new Error("CUDA out of memory. Tried to allocate 2.00 GiB");
const goodReply = {
  text: '{"explanation":"Use parameterised queries.","remediationSuggestions":"Bind params."}',
};

describe("developerReceivesAISecurityExplanations - insufficient VRAM (#1140, #1950)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    mockGenerate.mockReset();
    mockSetCached.mockReset();
    mockGetChain.mockReset();
    mockGetChain.mockReturnValue([PRIMARY, SMALL, TINY]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    vi.restoreAllMocks();
  });

  it("falls back to the smaller local model when the primary does not fit", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce(goodReply);

    const result = await developerReceivesAISecurityExplanations(input);

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[0][0].model).toBe(PRIMARY);
    expect(mockGenerate.mock.calls[1][0].model).toBe(SMALL);
    expect(result.explanation).toContain("parameterised");
  });

  it("does not cache an answer produced by a fallback model", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce(goodReply);
    await developerReceivesAISecurityExplanations(input);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("does not retry the same model on OOM or VRAMConcurrencyError and preserves air-gap", async () => {
    mockGenerate
      .mockRejectedValueOnce(CUDA_OOM)
      .mockRejectedValueOnce(new VRAMConcurrencyError())
      .mockResolvedValueOnce(goodReply);

    await developerReceivesAISecurityExplanations(input);

    const modelsCalled = mockGenerate.mock.calls.map((c) => c[0].model);
    expect(modelsCalled).toEqual([PRIMARY, SMALL, TINY]);
    for (const modelRef of modelsCalled) {
      expect(String(modelRef)).toMatch(/^openai\//);
      expect(String(modelRef)).not.toMatch(/^groq\//);
    }
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("returns one actionable message (no stack trace) when every model fails", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await developerReceivesAISecurityExplanations(input);

    expect(result.explanation).toBe(insufficientVramMessage([PRIMARY, SMALL, TINY]));
    expect(result.explanation).not.toMatch(/\n\s+at /);
    expect(result.explanation).not.toContain("Signal lost");
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("leaves unrelated errors on the existing path, without trying the fallback", async () => {
    mockGenerate.mockRejectedValue(new Error("boom: something else"));

    const result = await developerReceivesAISecurityExplanations(input);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.explanation).toContain("Signal lost");
  });
});
