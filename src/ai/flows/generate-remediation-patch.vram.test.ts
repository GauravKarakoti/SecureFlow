import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("genkit", async () => {
  const { z } = await import("zod");
  return { genkit: vi.fn(() => ({})), z };
});
vi.mock("@genkit-ai/compat-oai", () => ({ openAICompatible: vi.fn(() => ({})) }));

const mockGenerate = vi.fn();
const PRIMARY = "openai/llama3";
const FALLBACK_SMALL = "openai/llama3.2:3b";
const FALLBACK_TINY = "openai/llama3.2:1b";

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
}));

vi.mock("../../../packages/cli/src/threat-intel", () => ({
  queryLiveThreatIntelligence: vi.fn(async () => ""),
}));

vi.mock("dotenv/config", () => ({}));

import { generateRemediationPatch, PatchOutputSchema } from "./generate-remediation-patch";
import { insufficientVramMessage } from "@/ai/local-model";
import {
  VRAMConcurrencyError,
  resetLocalModelSemaphore,
  resetModelCircuitBreakers,
} from "@/ai/resilience";

const input = {
  vulnerableCode: 'db.query("SELECT * FROM u WHERE id=" + id)',
  findingDescription: "SQL injection via string concatenation.",
  filePath: "src/db.ts",
};

const OOM = new Error("model requires more system memory (8.4 GiB) than is available (5.1 GiB)");
const CUDA_OOM = new Error("CUDA out of memory. Tried to allocate 2.00 GiB");

const goodOutput = {
  patchDiff:
    '--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-db.query("SELECT * FROM u WHERE id=" + id)\n+db.query(sql, [id])',
  explanation: "Use a parameterised query.",
  verified: true,
  readyFix: true,
};

describe("generateRemediationPatch - insufficient VRAM (#1525, #1950)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    mockGenerate.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelCircuitBreakers();
    resetLocalModelSemaphore();
    vi.restoreAllMocks();
  });

  it("does not crash when the local model does not fit in memory", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await generateRemediationPatch(input);

    expect(result.patchDiff).toBe("");
    expect(result.failureReason).toBe("unavailable");
    expect(result.explanation).toContain("temporarily unavailable");
    expect(result.explanation).toContain(insufficientVramMessage([PRIMARY]));
  });

  it("does not crash on a CUDA out-of-memory error", async () => {
    mockGenerate.mockRejectedValue(CUDA_OOM);

    const result = await generateRemediationPatch(input);

    expect(result.patchDiff).toBe("");
    expect(result.failureReason).toBe("unavailable");
    expect(result.explanation).toContain("LOCAL_AI_FALLBACK_MODELS");
  });

  it("does not leak the raw OOM error or a stack trace to the caller", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await generateRemediationPatch(input);

    expect(result.explanation).not.toContain("GiB");
    expect(result.explanation).not.toMatch(/\n\s+at /);
  });

  it("returns an output that still matches the schema after an OOM", async () => {
    mockGenerate.mockRejectedValue(CUDA_OOM);

    const result = await generateRemediationPatch(input);

    expect(PatchOutputSchema.safeParse(result).success).toBe(true);
  });

  it("calls the provider once per request (no hidden retry loop on OOM)", async () => {
    mockGenerate.mockRejectedValue(OOM);

    await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("falls back sequentially through LOCAL_AI_FALLBACK_MODELS without cloud egress on OOM or VRAMConcurrencyError", async () => {
    vi.stubEnv("LOCAL_AI_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_AI_MODEL", "llama3");
    vi.stubEnv("LOCAL_AI_FALLBACK_MODELS", "llama3.2:3b,llama3.2:1b");

    mockGenerate
      .mockRejectedValueOnce(OOM)
      .mockRejectedValueOnce(new VRAMConcurrencyError())
      .mockResolvedValueOnce({ output: goodOutput });

    const result = await generateRemediationPatch(input);

    const modelsCalled = mockGenerate.mock.calls.map((c) => c[0].model);
    expect(modelsCalled).toEqual([PRIMARY, FALLBACK_SMALL, FALLBACK_TINY]);
    for (const modelRef of modelsCalled) {
      expect(String(modelRef)).not.toMatch(/^groq\//);
    }
    expect(result).toEqual(goodOutput);
  });

  it("lists every attempted local model in actionable explanation when all LOCAL_AI_FALLBACK_MODELS OOM", async () => {
    vi.stubEnv("LOCAL_AI_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_AI_MODEL", "llama3");
    vi.stubEnv("LOCAL_AI_FALLBACK_MODELS", "llama3.2:3b,llama3.2:1b");

    mockGenerate.mockRejectedValue(CUDA_OOM);

    const result = await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(3);
    expect(result.patchDiff).toBe("");
    expect(result.failureReason).toBe("unavailable");
    expect(result.explanation).toContain(
      insufficientVramMessage([PRIMARY, FALLBACK_SMALL, FALLBACK_TINY]),
    );
  });

  it("recovers on the next call once memory pressure is gone", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce({ output: goodOutput });

    const first = await generateRemediationPatch(input);
    const second = await generateRemediationPatch(input);

    expect(first.patchDiff).toBe("");
    expect(second).toEqual(goodOutput);
  });
});
