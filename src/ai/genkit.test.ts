import { describe, expect, it, vi } from "vitest";

// genkit.ts builds the Genkit instance at import time. Both packages are mocked so the
// test only exercises how GROQ_MODEL is turned into model references.
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
    vi.stubEnv("GROQ_MODEL", groqModel as string);
    if (groqModel === undefined) delete process.env.GROQ_MODEL;
    try {
      return await import("./genkit");
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it.each([undefined, "", "   "])(
    "uses Groq's current default, not the deprecated llama-3.1-8b-instant, when GROQ_MODEL is %j",
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
  ])("resolves GROQ_MODEL=%j to %s for both references", async (value, expected) => {
    const { DEFAULT_SECURITY_CONFIG, defaultModel } = await loadWith(value);

    expect(DEFAULT_SECURITY_CONFIG.modelName).toBe(expected);
    expect(defaultModel).toBe(expected);
  });
});
