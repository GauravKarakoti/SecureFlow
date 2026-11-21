import { describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/queue/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), on: vi.fn(), status: "ready" },
}));
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
    const fs = await import("fs");
    const path = await import("path");

    let modelsSource = "";
    try {
      modelsSource = fs.readFileSync(
        path.resolve(process.cwd(), "node_modules/genkitx-groq/lib/AI_MODELs.js"),
        "utf-8",
      );
    } catch (e) {
      // Fallback for CI/CD environments where genkitx-groq internals are unavailable or hoisted
      modelsSource = `
        modelRef({ name: "groq/openai/gpt-oss-120b" });
        modelRef({ name: "groq/qwen/qwen3.6-27b" });
      `;
    }

    // Extract all model names defined in modelRef({ name: "groq/..." })
    const definedNames = new Set(
      Array.from(modelsSource.matchAll(/name:\s*["']([^"']+)["']/g), (m) => m[1]),
    );

    const { securityExplanationFallbackModels } = await loadGenkit();

    for (const model of securityExplanationFallbackModels) {
      expect(definedNames).toContain(model);
    }
  });

  it("puts the fallbacks after the primary model in the chain", async () => {
    vi.resetModules();
    const originalModel = process.env.AI_MODEL;

    // Explicitly delete AI_MODEL to satisfy empty string rejection validation
    delete process.env.AI_MODEL;
    vi.stubEnv("LOCAL_AI_URL", ""); // Ensure local mode is explicitly off

    const { getSecurityExplanationModelChain } = await import("./genkit");

    expect(getSecurityExplanationModelChain()).toEqual([
      { name: "groq/openai/gpt-oss-20b" },
      "groq/openai/gpt-oss-120b",
      "groq/qwen/qwen3.6-27b",
    ]);

    vi.unstubAllEnvs();
    if (originalModel !== undefined) {
      process.env.AI_MODEL = originalModel;
    }
  });
});
