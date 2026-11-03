import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();
const PRIMARY = "openai/llama3";

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
}));

const mockSetCached = vi.fn();
vi.mock("@/lib/explanation-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/explanation-cache")>()),
  getCachedExplanation: vi.fn(async () => null),
  setCachedExplanation: (...args: unknown[]) => mockSetCached(...args),
}));

vi.mock("dotenv/config", () => ({}));

import { web3SecurityExplanation } from "./web3-security-explanations";

const input = {
  findingType: "Under-constrained signal",
  severity: "Critical",
  fileLocation: "circuits/range.circom",
  codeSnippet: "signal output out; out <-- in * 2;",
  description: "Output signal is assigned but not constrained.",
};

const OOM = new Error("model requires more system memory (8.4 GiB) than is available (5.1 GiB)");
const CUDA_OOM = new Error("CUDA out of memory. Tried to allocate 2.00 GiB");

const goodReply = {
  text: '{"explanation":"Soundness bug: prover can pick any out.","remediationSuggestions":"Use <== to constrain the signal."}',
};

describe("web3SecurityExplanation - insufficient VRAM (#1525)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockSetCached.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("does not crash when the local model does not fit in memory", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await web3SecurityExplanation(input);

    expect(result.explanation.length).toBeGreaterThan(0);
    expect(result.remediationSuggestions.length).toBeGreaterThan(0);
  });

  it("does not crash on a CUDA out-of-memory error", async () => {
    mockGenerate.mockRejectedValue(CUDA_OOM);

    await expect(web3SecurityExplanation(input)).resolves.toBeDefined();
  });

  it("returns a message without a stack trace on OOM", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).not.toMatch(/\n\s+at /);
    expect(result.remediationSuggestions).not.toMatch(/\n\s+at /);
  });

  it("never caches the fallback text produced after an OOM", async () => {
    mockGenerate.mockRejectedValue(OOM);

    await web3SecurityExplanation(input);

    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("recovers on the next call once memory pressure is gone", async () => {
    mockGenerate.mockRejectedValue(OOM);
    await web3SecurityExplanation(input);

    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue(goodReply);
    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toContain("Soundness");
    expect(mockSetCached).toHaveBeenCalledTimes(1);
  });

  it("uses the ZK circuit prompt for .circom files even under memory pressure", async () => {
    mockGenerate.mockResolvedValue(goodReply);

    await web3SecurityExplanation(input);

    expect(mockGenerate.mock.calls[0][0].prompt).toContain("zero-knowledge circuit");
  });
});
