import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("genkit", () => ({ genkit: vi.fn().mockReturnValue({}) }));
vi.mock("@genkit-ai/compat-oai", () => ({ openAICompatible: vi.fn().mockReturnValue({}) }));
vi.mock("genkitx-groq", () => ({
  groq: vi.fn(() => ({})),
  gptOssx20b: { name: "groq/openai/gpt-oss-20b" },
}));

import {
  InsufficientVRAMError,
  insufficientVramMessage,
  isInsufficientMemoryError,
  resolveLocalFallbackModels,
} from "./local-model";
import {
  DEFAULT_LOCAL_QUEUE_WAIT_MS,
  DEFAULT_LOCAL_VRAM_CONCURRENCY,
  Semaphore,
  VRAMConcurrencyError,
  executeWithFallbackAndRetry,
  getLocalModelVramThreshold,
  getLocalQueueWaitMs,
  isVramConcurrencyError,
  resetLocalModelSemaphore,
  resetModelCircuitBreakers,
} from "./resilience";
import { getSecurityExplanationModelChain } from "./genkit";

afterEach(() => {
  vi.unstubAllEnvs();
  resetLocalModelSemaphore();
  resetModelCircuitBreakers();
  vi.restoreAllMocks();
});

describe("isInsufficientMemoryError (docs/local-inference.md)", () => {
  it.each([
    "model requires more system memory (8.4 GiB) than is available (5.1 GiB)",
    "CUDA error: out of memory",
    "torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB",
    "ggml_cuda_host_malloc: failed to allocate 4096 MiB of pinned memory",
    "unable to allocate 512 MiB compute buffer",
    "No available memory for the cache blocks",
    "insufficient VRAM for requested model",
    "insufficient gpu memory",
    "not enough memory to load model",
    "cudaMalloc failed: out of memory",
    "Worker terminated with OOM status",
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
    const err = new InsufficientVRAMError(["llama3", "llama3.2:3b", "llama3.2:1b"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientVRAMError");
    expect(err.modelsTried).toEqual(["llama3", "llama3.2:3b", "llama3.2:1b"]);
    expect(err.message).toContain('"llama3"');
    expect(err.message).toContain('"llama3.2:3b"');
    expect(err.message).toContain('"llama3.2:1b"');
    expect(err.message).toContain("LOCAL_AI_MODEL=llama3.2:3b");
    expect(err.message).toContain("LOCAL_AI_FALLBACK_MODELS");
    expect(err.message).not.toContain("\n");
  });

  it("insufficientVramMessage works with no model names", () => {
    expect(insufficientVramMessage([])).toContain("the active model");
  });
});

describe("resolveLocalFallbackModels & Air-Gap Invariant", () => {
  const local = { LOCAL_AI_URL: "http://localhost:11434/v1", LOCAL_AI_MODEL: "llama3" };

  it("returns [] when local mode is off", () => {
    expect(resolveLocalFallbackModels({ LOCAL_AI_FALLBACK_MODELS: "llama3.2:3b" })).toEqual([]);
  });

  it("returns [] when no fallbacks are configured", () => {
    expect(resolveLocalFallbackModels(local)).toEqual([]);
  });

  it("parses documented fallback chain, trimming blanks and keeping order", () => {
    expect(
      resolveLocalFallbackModels({
        ...local,
        LOCAL_AI_FALLBACK_MODELS: " llama3.2:3b, ,llama3.2:1b ,",
      }),
    ).toEqual(["llama3.2:3b", "llama3.2:1b"]);
  });

  it("resolves fallback models under dedicated vLLM and Ollama variables", () => {
    expect(
      resolveLocalFallbackModels({
        VLLM_URL: "http://10.0.0.5:8000",
        VLLM_MODEL: "meta-llama/Meta-Llama-3-8B-Instruct",
        LOCAL_AI_FALLBACK_MODELS: "llama3.2:3b,llama3.2:1b",
      }),
    ).toEqual(["llama3.2:3b", "llama3.2:1b"]);

    expect(
      resolveLocalFallbackModels({
        LOCAL_AI_PROVIDER: "ollama",
        LOCAL_AI_FALLBACK_MODELS: "llama3,llama3.2:3b,llama3.2:1b",
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

  it("preserves air-gap invariant: local fallback chain never routes to cloud providers", () => {
    vi.stubEnv("LOCAL_AI_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_AI_MODEL", "llama3");
    vi.stubEnv("LOCAL_AI_FALLBACK_MODELS", "llama3.2:3b,llama3.2:1b");

    const chain = getSecurityExplanationModelChain();
    expect(chain).toEqual(["openai/llama3", "openai/llama3.2:3b", "openai/llama3.2:1b"]);
    for (const ref of chain) {
      expect(String(ref)).toMatch(/^openai\//);
      expect(String(ref)).not.toMatch(/^groq\//);
    }
  });
});

describe("VRAM concurrency & queue budget thresholds (docs/helm-local-inference-vram-hpa.md)", () => {
  it("defaults concurrency threshold to 1 and queue wait budget to 30000ms", () => {
    expect(DEFAULT_LOCAL_VRAM_CONCURRENCY).toBe(1);
    expect(DEFAULT_LOCAL_QUEUE_WAIT_MS).toBe(30_000);
    expect(getLocalModelVramThreshold({})).toBe(1);
    expect(getLocalQueueWaitMs({})).toBe(30_000);
  });

  it("honors documented concurrency env precedence and rejects invalid values", () => {
    expect(
      getLocalModelVramThreshold({
        LOCAL_AI_MAX_CONCURRENCY: "4",
        LOCAL_AI_CONCURRENCY_LIMIT: "3",
        VRAM_CONCURRENCY_THRESHOLD: "2",
      }),
    ).toBe(4);
    expect(
      getLocalModelVramThreshold({
        LOCAL_AI_CONCURRENCY_LIMIT: "3",
        VRAM_CONCURRENCY_THRESHOLD: "2",
      }),
    ).toBe(3);
    expect(getLocalModelVramThreshold({ VRAM_CONCURRENCY_THRESHOLD: "2" })).toBe(2);
    expect(getLocalModelVramThreshold({ VRAM_CONCURRENCY_THRESHOLD: "0" })).toBe(1);
    expect(getLocalModelVramThreshold({ VRAM_CONCURRENCY_THRESHOLD: "invalid" })).toBe(1);
  });

  it("parses LOCAL_AI_MAX_QUEUE_WAIT_MS and rejects invalid or negative budgets", () => {
    expect(getLocalQueueWaitMs({ LOCAL_AI_MAX_QUEUE_WAIT_MS: "15000" })).toBe(15_000);
    expect(getLocalQueueWaitMs({ LOCAL_AI_MAX_QUEUE_WAIT_MS: "0" })).toBe(0);
    expect(getLocalQueueWaitMs({ LOCAL_AI_MAX_QUEUE_WAIT_MS: "-100" })).toBe(30_000);
    expect(getLocalQueueWaitMs({ LOCAL_AI_MAX_QUEUE_WAIT_MS: "not-a-number" })).toBe(30_000);
  });

  it("honors LOCAL_AI_MAX_QUEUE_WAIT_MS and fails over on VRAMConcurrencyError without retrying primary", async () => {
    vi.stubEnv("LOCAL_AI_MAX_QUEUE_WAIT_MS", "20");
    const sem = new Semaphore(1);
    const holdPermit = await sem.acquire();
    let released = false;

    const op = vi.fn(async (model: string) => `handled-by:${model}`);
    const onModelSwitch = vi.fn(() => {
      if (!released) {
        released = true;
        holdPermit();
      }
    });

    const { result, stats } = await executeWithFallbackAndRetry(op, {
      primaryModel: "openai/llama3",
      fallbackModels: ["openai/llama3.2:3b"],
      concurrencySemaphore: sem,
      onModelSwitch,
    });

    expect(result).toBe("handled-by:openai/llama3.2:3b");
    expect(stats.modelUsed).toBe("openai/llama3.2:3b");
    expect(stats.fallbackSwitches).toBe(1);
    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith("openai/llama3.2:3b", 1);
    expect(onModelSwitch).toHaveBeenCalledWith(
      "openai/llama3",
      "openai/llama3.2:3b",
      expect.any(VRAMConcurrencyError),
      1,
    );
    expect(isVramConcurrencyError(new VRAMConcurrencyError())).toBe(true);
  });

  it("throws VRAMConcurrencyError when all local models exceed LOCAL_AI_MAX_QUEUE_WAIT_MS", async () => {
    vi.stubEnv("LOCAL_AI_MAX_QUEUE_WAIT_MS", "15");
    const sem = new Semaphore(1);
    const holdPermit = await sem.acquire();

    try {
      const op = vi.fn(async () => "unreachable");
      await expect(
        executeWithFallbackAndRetry(op, {
          primaryModel: "openai/llama3",
          fallbackModels: ["openai/llama3.2:3b"],
          concurrencySemaphore: sem,
        }),
      ).rejects.toThrow(VRAMConcurrencyError);
      expect(op).not.toHaveBeenCalled();
    } finally {
      holdPermit();
    }
  });
});
