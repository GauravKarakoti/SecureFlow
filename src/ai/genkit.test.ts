import { describe, expect, it, vi } from "vitest";

// builds the Genkit instance at import time. Both packages are mocked so the
// test only exercises how AI_MODEL is turned into model references.
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

// Prevent local-model.ts from executing its top-level network pings
// which otherwise cause an infinite retry loop during module initialization.
vi.mock("./local-model", () => ({
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

describe("toGenkitGroqModel", () => {
  it("adds the groq/ namespace to a bare Groq model id", async () => {
    const { toGenkitGroqModel } = await loadGenkit();
    expect(toGenkitGroqModel("openai/gpt-oss-20b")).toBe("groq/openai/gpt-oss-20b");
    expect(toGenkitGroqModel("llama-3.1-8b-instant")).toBe("groq/llama-3.1-8b-instant");
  });

  it("leaves an id that already has the namespace unchanged", async () => {
    const { toGenkitGroqModel } = await loadGenkit();
    expect(toGenkitGroqModel("groq/llama-3.3-70b-versatile")).toBe("groq/llama-3.3-70b-versatile");
    expect(toGenkitGroqModel("  groq/openai/gpt-oss-20b ")).toBe("groq/openai/gpt-oss-20b");
  });
});

describe("model defaults", () => {
  async function loadWith(groqModel: string | undefined) {
    vi.resetModules();
    vi.stubEnv("AI_MODEL", groqModel as string);
    vi.stubEnv("LOCAL_AI_URL", "");
    if (groqModel === undefined) delete process.env.AI_MODEL;
    try {
      return await import("./genkit");
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it.each([undefined, "", "   "])(
    "uses Groq's current default, not the deprecated llama-3.1-8b-instant, when AI_MODEL is %j",
    async (value) => {
      const { DEFAULT_SECURITY_CONFIG, defaultModel } = await loadWith(value);

      expect(DEFAULT_SECURITY_CONFIG.modelName).toBe("groq/openai/gpt-oss-20b");
      expect(defaultModel).toBe("groq/openai/gpt-oss-20b");
    },
  );

  it.each([
    ["llama-3.3-70b-versatile", "groq/llama-3.3-70b-versatile"],
    ["groq/llama-3.3-70b-versatile", "groq/llama-3.3-70b-versatile"],
    [" openai/gpt-oss-120b ", "groq/openai/gpt-oss-120b"],
  ])("resolves AI_MODEL=%j to %s for both references", async (value, expected) => {
    const { DEFAULT_SECURITY_CONFIG, defaultModel } = await loadWith(value);

    expect(DEFAULT_SECURITY_CONFIG.modelName).toBe(expected);
    expect(defaultModel).toBe(expected);
  });
});

describe("dynamic model configuration for remediation & explanations", () => {
  it("resolves AI_MODEL override for getDefaultModelRef without code changes", async () => {
    vi.resetModules();
    vi.stubEnv("AI_MODEL", "openai/gpt-oss-120b");
    try {
      const { getDefaultModelRef } = await import("./genkit");
      expect(getDefaultModelRef()).toBe("groq/openai/gpt-oss-120b");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves AI_PROVIDER=ollama and AI_MODEL=codellama to openai/codellama", async () => {
    vi.resetModules();
    vi.stubEnv("AI_PROVIDER", "ollama");
    vi.stubEnv("AI_MODEL", "codellama");
    try {
      const { getDefaultModelRef } = await import("./genkit");
      expect(getDefaultModelRef()).toBe("openai/codellama");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("updates model chain with custom AI_MODEL at the front", async () => {
    vi.resetModules();
    vi.stubEnv("AI_MODEL", "groq/llama-3.3-70b-versatile");
    try {
      const { getSecurityExplanationModelChain } = await import("./genkit");
      const chain = getSecurityExplanationModelChain();
      expect(chain[0]).toBe("groq/llama-3.3-70b-versatile");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
