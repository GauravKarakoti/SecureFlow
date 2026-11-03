import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();
const PRIMARY = "groq/openai/gpt-oss-20b";

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
  findingType: "Reentrancy",
  severity: "High",
  fileLocation: "contracts/Vault.sol",
  codeSnippet: 'msg.sender.call{value: amount}(""); balances[msg.sender] = 0;',
  description: "State is updated after an external call.",
};

const rateLimit = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });

const goodReply = {
  text: '{"explanation":"Reentrancy via external call before state update.","remediationSuggestions":"Use Checks-Effects-Interactions."}',
};

describe("web3SecurityExplanation - provider fallback (#1525)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockSetCached.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the model answer and caches it when the provider succeeds", async () => {
    mockGenerate.mockResolvedValue(goodReply);

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toContain("Reentrancy");
    expect(result.remediationSuggestions).toContain("Checks-Effects-Interactions");
    expect(mockSetCached).toHaveBeenCalledTimes(1);
  });

  it("returns a graceful rate-limit message when the provider keeps returning 429", async () => {
    mockGenerate.mockRejectedValue(rateLimit());

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toContain("rate limit");
    expect(result.explanation).not.toMatch(/\n\s+at /);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("returns the generic 'Signal lost' fallback on an unknown error", async () => {
    mockGenerate.mockRejectedValue(new Error("boom: something else"));

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toContain("Signal lost");
    expect(result.remediationSuggestions).toContain("security checklist");
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("never throws when the provider is down, and the output matches the schema", async () => {
    mockGenerate.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await web3SecurityExplanation(input);

    expect(typeof result.explanation).toBe("string");
    expect(typeof result.remediationSuggestions).toBe("string");
    expect(typeof result.promptInjectionSuspected).toBe("boolean");
  });

  it("uses 'No explanation provided.' and does not cache when the reply is not valid JSON", async () => {
    mockGenerate.mockResolvedValue({ text: "sorry, I cannot help with that" });

    const result = await web3SecurityExplanation(input);

    expect(result.explanation).toBe("No explanation provided.");
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("falls back to the generic Web3 flow for unknown file types", async () => {
    mockGenerate.mockResolvedValue(goodReply);

    await web3SecurityExplanation({
      ...input,
      findingType: "Oracle Manipulation",
      fileLocation: "protocol/oracle.txt",
    });

    const call = mockGenerate.mock.calls[0][0];
    expect(call.prompt).toContain("Web3 protocol breach");
  });
});
