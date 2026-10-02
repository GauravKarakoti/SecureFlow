import { describe, expect, it, vi, beforeAll } from "vitest";

const { getCachedGenkit, setCachedGenkit } = vi.hoisted(() => {
  let cached: any = null;
  return {
    getCachedGenkit: () => cached,
    setCachedGenkit: (val: any) => {
      cached = val;
    },
  };
});

// We use `importOriginal` to retain all the real schemas (like `GenerationCommonConfigSchema`)
// that plugins like `genkitx-groq` rely on. To avoid Vitest's known deadlock when
// `importOriginal` is called after `vi.resetModules()`, we cache the real module
// and reuse it on subsequent evaluations.
vi.mock("genkit", async (importOriginal) => {
  let cached = getCachedGenkit();
  if (!cached) {
    cached = await importOriginal<typeof import("genkit")>();
    setCachedGenkit(cached);
  }
  return {
    ...cached,
    genkit: vi.fn(() => ({})),
  };
});

vi.mock("genkitx-groq", () => ({
  groq: vi.fn(() => ({})),
  gptOssx20b: { name: "groq/openai/gpt-oss-20b" },
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/queue/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), on: vi.fn(), status: "ready" },
}));

// Prevent local-model.ts from executing its top-level network pings
// which otherwise cause an infinite retry loop during module initialization.
// Mock both the relative and absolute alias paths to ensure Vitest successfully
// intercepts the import regardless of how genkit.ts specifies it.
vi.mock("./local-model", () => ({
  resolveLocalModelConfig: vi.fn(() => null),
  isLocalModelEnabled: false,
  createLocalAiInstance: vi.fn(),
  localModelRef: vi.fn(),
}));

vi.mock("@/ai/local-model", () => ({
  resolveLocalModelConfig: vi.fn(() => null),
  isLocalModelEnabled: false,
  createLocalAiInstance: vi.fn(),
  localModelRef: vi.fn(),
}));

async function loadGenkit() {
  vi.resetModules();
  vi.stubEnv("LOCAL_AI_URL", "");
  return import("./genkit");
}

describe("security explanation fallback chain", () => {
  beforeAll(async () => {
    // Pre-load the module before any vi.resetModules() calls to populate the
    // hoisted cache, avoiding the Vitest importOriginal + resetModules deadlock.
    await import("genkit");
  });

  // Shut down by Groq (https://console.groq.com/docs/deprecations).
  const SHUT_DOWN = [
    "groq/llama-3.3-70b-versatile",
    "groq/llama-3.1-8b-instant",
    "groq/mixtral-8x7b-32768",
  ];

  it("falls back only to models that are still served", async () => {
    const { securityExplanationFallbackModels } = await loadGenkit();

    expect(securityExplanationFallbackModels).toEqual([
      "groq/openai/gpt-oss-120b",
      "groq/qwen/qwen3.6-27b",
    ]);
    for (const model of SHUT_DOWN) {
      expect(securityExplanationFallbackModels).not.toContain(model);
    }
  });

  it("only names models the genkitx-groq plugin defines", async () => {
    // Replace the createRequire line with vi.importActual:
    const real = await vi.importActual<Record<string, unknown>>("genkitx-groq");

    const defined = new Set(
      Object.values(real)
        .map((value) => (value as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === "string"),
    );

    const { securityExplanationFallbackModels } = await loadGenkit();

    for (const model of securityExplanationFallbackModels) {
      expect(defined).toContain(model);
    }
  });

  it("puts the fallbacks after the primary model in the chain", async () => {
    vi.resetModules();
    vi.stubEnv("GROQ_MODEL", "");
    vi.stubEnv("LOCAL_AI_URL", ""); // Ensure local mode is explicitly off
    const { getSecurityExplanationModelChain } = await import("./genkit");

    expect(getSecurityExplanationModelChain()).toEqual([
      { name: "groq/openai/gpt-oss-20b" },
      "groq/openai/gpt-oss-120b",
      "groq/qwen/qwen3.6-27b",
    ]);

    vi.unstubAllEnvs();
  });
});
