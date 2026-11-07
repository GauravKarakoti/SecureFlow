import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => "groq/openai/gpt-oss-20b"),
}));

// Keep the live threat-intel lookup out of the test.
vi.mock("../../../cli/src/threat-intel", () => ({
  queryLiveThreatIntelligence: vi.fn(async () => ""),
}));

vi.mock("dotenv/config", () => ({}));

import { generateRemediationPatch, PatchOutputSchema } from "./generate-remediation-patch";

const input = {
  vulnerableCode: 'db.query("SELECT * FROM u WHERE id=" + id)',
  findingDescription: "SQL injection via string concatenation.",
  filePath: "src/db.ts",
};

const goodOutput = {
  patchDiff: "--- a/src/db.ts\n+++ b/src/db.ts\n@@\n-db.query(...)\n+db.query(sql, [id])",
  explanation: "Use a parameterised query.",
};

describe("generateRemediationPatch - provider fallback (#1525)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the model output when the provider succeeds", async () => {
    mockGenerate.mockResolvedValue({ output: goodOutput });

    const result = await generateRemediationPatch(input);

    expect(result).toEqual(goodOutput);
  });

  it("returns the static fallback when the provider throws", async () => {
    mockGenerate.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await generateRemediationPatch(input);

    expect(result.patchDiff).toBe("");
    expect(result.explanation).toContain("temporarily unavailable");
  });

  it("returns the static fallback on a 429 rate limit", async () => {
    mockGenerate.mockRejectedValue(
      Object.assign(new Error("429 Too Many Requests"), { status: 429 }),
    );

    const result = await generateRemediationPatch(input);

    expect(result.patchDiff).toBe("");
    expect(result.explanation).toContain("temporarily unavailable");
  });

  it("returns the static fallback when the model returns no structured output", async () => {
    mockGenerate.mockResolvedValue({ output: null });

    const result = await generateRemediationPatch(input);

    expect(result.patchDiff).toBe("");
    expect(result.explanation).toContain("review the vulnerability manually");
  });

  it("always returns a value that matches the output schema", async () => {
    mockGenerate.mockRejectedValue(new Error("boom"));

    const result = await generateRemediationPatch(input);

    expect(PatchOutputSchema.safeParse(result).success).toBe(true);
  });

  it("logs a warning but does not throw when the provider is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGenerate.mockRejectedValue(new Error("boom"));

    await expect(generateRemediationPatch(input)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
  });

  it("rejects invalid input instead of silently falling back", async () => {
    await expect(
      generateRemediationPatch({ vulnerableCode: 1 } as unknown as typeof input),
    ).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
