import { describe, expect, it, vi } from "vitest";

vi.mock("genkit", () => ({ genkit: vi.fn().mockReturnValue({}) }));
vi.mock("@genkit-ai/compat-oai", () => ({ openAICompatible: vi.fn().mockReturnValue({}) }));

import {
  InsufficientVRAMError,
  insufficientVramMessage,
  isInsufficientMemoryError,
  resolveLocalFallbackModels,
} from "./local-model";

describe("isInsufficientMemoryError", () => {
  it.each([
    "model requires more system memory (8.4 GiB) than is available (5.1 GiB)",
    "CUDA error: out of memory",
    "torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB",
    "ggml_cuda_host_malloc: failed to allocate 4096 MiB of pinned memory",
    "No available memory for the cache blocks",
    "insufficient VRAM for requested model",
    "not enough memory to load model",
    "cudaMalloc failed: out of memory",
  ])("recognises %s", (message) => {
    expect(isInsufficientMemoryError(new Error(message))).toBe(true);
  });

  it("recognises plain string errors and InsufficientVRAMError instances", () => {
    expect(isInsufficientMemoryError("out of memory")).toBe(true);
    expect(isInsufficientMemoryError(new InsufficientVRAMError(["llama3"]))).toBe(true);
  });

  it.each([
    new Error("429 Too Many Requests"),
    new Error("connect ECONNREFUSED 127.0.0.1:11434"),
    new Error("request timed out"),
    new Error("model 'llama3' not found"),
    new Error("CUDA driver version is insufficient for CUDA runtime version"),
    new Error("Cannot read properties of undefined (reading 'memory')"),
    null,
    undefined,
  ])("ignores unrelated error %s", (err) => {
    expect(isInsufficientMemoryError(err)).toBe(false);
  });
});

describe("InsufficientVRAMError", () => {
  it("carries a one-line actionable message naming every model tried", () => {
    const err = new InsufficientVRAMError(["llama3", "llama3.2:3b"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientVRAMError");
    expect(err.modelsTried).toEqual(["llama3", "llama3.2:3b"]);
    expect(err.message).toContain('"llama3"');
    expect(err.message).toContain('"llama3.2:3b"');
    expect(err.message).toContain("LOCAL_AI_FALLBACK_MODELS");
    expect(err.message).not.toContain("\n");
  });

  it("insufficientVramMessage works with no model names", () => {
    expect(insufficientVramMessage([])).toContain("the active model");
  });
});

describe("resolveLocalFallbackModels", () => {
  const local = { LOCAL_AI_URL: "http://localhost:11434/v1", LOCAL_AI_MODEL: "llama3" };

  it("returns [] when local mode is off", () => {
    expect(resolveLocalFallbackModels({ LOCAL_AI_FALLBACK_MODELS: "llama3.2:3b" })).toEqual([]);
  });

  it("returns [] when no fallbacks are configured", () => {
    expect(resolveLocalFallbackModels(local)).toEqual([]);
  });

  it("parses a comma-separated list, trimming blanks and keeping order", () => {
    expect(
      resolveLocalFallbackModels({
        ...local,
        LOCAL_AI_FALLBACK_MODELS: " llama3.2:3b, ,llama3.2:1b ,",
      }),
    ).toEqual(["llama3.2:3b", "llama3.2:1b"]);
  });

  it("drops the active model and duplicates", () => {
    expect(
      resolveLocalFallbackModels({
        ...local,
        LOCAL_AI_FALLBACK_MODELS: "llama3,llama3.2:3b,llama3.2:3b",
      }),
    ).toEqual(["llama3.2:3b"]);
  });
});
