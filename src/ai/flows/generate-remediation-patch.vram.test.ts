import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();
const PRIMARY = "openai/llama3";

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
}));

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

const OOM = new Error("model requires more system memory (8.4 GiB) than is available (5.1 GiB)");
const CUDA_OOM = new Error("CUDA out of memory. Tried to allocate 2.00 GiB");

const goodOutput = {
  patchDiff: "--- a/src/db.ts\n+++ b/src/db.ts\n@@\n-db.query(...)\n+db.query(sql, [id])",
  explanation: "Use a parameterised query.",
};

describe("generateRemediationPatch - insufficient VRAM (#1525)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("does not crash when the local model does not fit in memory", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await generateRemediationPatch(input);

    expect(result.patchDiff).toBe("");
    expect(result.explanation).toContain("temporarily unavailable");
  });

  it("does not crash on a CUDA out-of-memory error", async () => {
    mockGenerate.mockRejectedValue(CUDA_OOM);

    await expect(generateRemediationPatch(input)).resolves.toBeDefined();
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

  it("recovers on the next call once memory pressure is gone", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce({ output: goodOutput });

    const first = await generateRemediationPatch(input);
    const second = await generateRemediationPatch(input);

    expect(first.patchDiff).toBe("");
    expect(second).toEqual(goodOutput);
  });
});
