import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// genkit.ts builds the Genkit instance at import time, so both packages are
// mocked; the real plugin is only read (below) for its list of model names.
vi.mock("genkit", () => ({ genkit: vi.fn(() => ({})) }));
vi.mock("genkitx-groq", () => ({
  groq: vi.fn(() => ({})),
  gptOssx20b: { name: "groq/openai/gpt-oss-20b" },
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
  },
}));

async function loadGenkit() {
  return import("./genkit");
}

describe("security explanation fallback chain", () => {
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
    // The CommonJS build: the package's ESM entry has an extensionless import
    // that Vitest cannot resolve.
    const real = createRequire(import.meta.url)("genkitx-groq") as Record<string, unknown>;
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
