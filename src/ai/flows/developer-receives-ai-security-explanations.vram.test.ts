import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();
const PRIMARY = "openai/llama3";
const SMALL = "openai/llama3.2:3b";

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
  getSecurityExplanationModelChain: vi.fn(() => [PRIMARY, SMALL]),
}));

// Local mode on; keep the real error helpers.
vi.mock("@/ai/local-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ai/local-model")>()),
  isLocalModelEnabled: vi.fn(() => true),
}));

const mockSetCached = vi.fn();
vi.mock("@/lib/explanation-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/explanation-cache")>()),
  getCachedExplanation: vi.fn(async () => null),
  setCachedExplanation: (...args: unknown[]) => mockSetCached(...args),
}));

vi.mock("dotenv/config", () => ({}));

import { developerReceivesAISecurityExplanations } from "./developer-receives-ai-security-explanations";

const input = {
  findingType: "SQL Injection",
  severity: "High",
  fileLocation: "src/db.ts",
  codeSnippet: 'db.query("SELECT * FROM u WHERE id=" + id)',
  description: "User input is concatenated into a SQL query.",
};

const OOM = new Error("model requires more system memory (8.4 GiB) than is available (5.1 GiB)");
const goodReply = {
  text: '{"explanation":"Use parameterised queries.","remediationSuggestions":"Bind params."}',
};

describe("developerReceivesAISecurityExplanations - insufficient VRAM (#1140)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockSetCached.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("falls back to the smaller local model when the primary does not fit", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce(goodReply);

    const result = await developerReceivesAISecurityExplanations(input);

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[0][0].model).toBe(PRIMARY);
    expect(mockGenerate.mock.calls[1][0].model).toBe(SMALL);
    expect(result.explanation).toContain("parameterised");
  });

  it("does not cache an answer produced by a fallback model", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce(goodReply);
    await developerReceivesAISecurityExplanations(input);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("does not retry the same model on an out-of-memory error", async () => {
    mockGenerate.mockRejectedValueOnce(OOM).mockResolvedValueOnce(goodReply);
    await developerReceivesAISecurityExplanations(input);
    const modelsCalled = mockGenerate.mock.calls.map((c) => c[0].model);
    expect(modelsCalled).toEqual([PRIMARY, SMALL]);
  });

  it("returns one actionable message (no stack trace) when every model fails", async () => {
    mockGenerate.mockRejectedValue(OOM);

    const result = await developerReceivesAISecurityExplanations(input);

    expect(result.explanation).toContain("Not enough GPU memory");
    expect(result.explanation).toContain(PRIMARY);
    expect(result.explanation).toContain(SMALL);
    expect(result.explanation).toContain("LOCAL_AI_FALLBACK_MODELS");
    expect(result.explanation).not.toMatch(/\n\s+at /);
    expect(result.explanation).not.toContain("Signal lost");
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("leaves unrelated errors on the existing path, without trying the fallback", async () => {
    mockGenerate.mockRejectedValue(new Error("boom: something else"));

    const result = await developerReceivesAISecurityExplanations(input);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.explanation).toContain("Signal lost");
  });
});
