import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => "groq/openai/gpt-oss-20b"),
}));

vi.mock("../../../cli/src/threat-intel", () => ({
  queryLiveThreatIntelligence: vi.fn(async () => ""),
}));

vi.mock("dotenv/config", () => ({}));

import { generateRemediationPatch } from "./generate-remediation-patch";

const input = {
  vulnerableCode: 'db.query("SELECT * FROM u WHERE id=" + id)',
  findingDescription: "SQL injection via string concatenation.",
  filePath: "src/db.ts",
};

const goodOutput = {
  patchDiff: "--- a/src/db.ts\n+++ b/src/db.ts\n@@\n-db.query(...)\n+db.query(sql, [id])",
  explanation: "Use a parameterised query.",
};

const rateLimit = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });

describe("generateRemediationPatch - backoff and retry (#1513)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retries a rate limit and returns the patch once the provider recovers", async () => {
    mockGenerate
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValueOnce({ output: goodOutput });

    const result = await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(3);
    expect(result).toEqual(goodOutput);
  });

  it("gives up after the retries are exhausted and reports a rate limit", async () => {
    mockGenerate.mockRejectedValue(rateLimit());

    const result = await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(4);
    expect(result.patchDiff).toBe("");
    expect(result.failureReason).toBe("rate_limit");
    expect(result.explanation).toContain("rate limit");
  });

  it("retries a timeout and reports a timeout when it keeps failing", async () => {
    mockGenerate.mockRejectedValue(new Error("Connection timed out"));

    const result = await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(4);
    expect(result.failureReason).toBe("timeout");
    expect(result.explanation).toContain("timed out");
  });

  it("does not retry an error that is not a rate limit or a timeout", async () => {
    mockGenerate.mockRejectedValue(new Error("boom: something else"));

    const result = await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.failureReason).toBe("unavailable");
    expect(result.patchDiff).toBe("");
  });

  it("does not set a failure reason when the provider succeeds first time", async () => {
    mockGenerate.mockResolvedValue({ output: goodOutput });

    const result = await generateRemediationPatch(input);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.failureReason).toBeUndefined();
  });
});
