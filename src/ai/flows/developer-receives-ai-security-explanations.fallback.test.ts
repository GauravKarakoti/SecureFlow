import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.fn();
const PRIMARY = "groq/openai/gpt-oss-20b";
const SECONDARY = "groq/openai/gpt-oss-120b";

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => PRIMARY),
  getSecurityExplanationModelChain: vi.fn(() => [PRIMARY, SECONDARY]),
}));

const mockSetCached = vi.fn();
vi.mock("@/lib/explanation-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/explanation-cache")>()),
  getCachedExplanation: vi.fn(async () => null),
  setCachedExplanation: (...args: unknown[]) => mockSetCached(...args),
}));

const mockRecordFallback = vi.fn();
vi.mock("@/lib/audit/ai-fallback-audit", () => ({
  recordAiFallbackEvent: (...args: unknown[]) => mockRecordFallback(...args),
}));

vi.mock("dotenv/config", () => ({}));

import { developerReceivesAISecurityExplanations } from "./developer-receives-ai-security-explanations";
import { tripModelCircuitBreaker, resetModelCircuitBreakers } from "@/ai/resilience";

const input = {
  findingType: "SQL Injection",
  severity: "High",
  fileLocation: "src/db.ts",
  codeSnippet: 'db.query("SELECT * FROM u WHERE id=" + id)',
  description: "User input is concatenated into a SQL query.",
};

const rateLimit = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });

const goodReply = {
  text: '{"explanation":"Use parameterised queries.","remediationSuggestions":"Bind params."}',
};

describe("developerReceivesAISecurityExplanations - 429 fallback (#1233, #1768)", () => {
  beforeEach(() => {
    resetModelCircuitBreakers();
    mockGenerate.mockReset();
    mockSetCached.mockReset();
    mockRecordFallback.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetModelCircuitBreakers();
  });

  it("routes to the secondary model when the primary returns 429", async () => {
    mockGenerate.mockImplementation(async ({ model }: { model: string }) => {
      if (model === PRIMARY) throw rateLimit();
      return goodReply;
    });

    const result = await developerReceivesAISecurityExplanations(input);

    const models = mockGenerate.mock.calls.map((c) => c[0].model);
    expect(models).toContain(PRIMARY);
    expect(models[models.length - 1]).toBe(SECONDARY);
    expect(result.explanation).toContain("parameterised");
  });

  it("writes an audit event when it switches to the fallback model", async () => {
    mockGenerate.mockImplementation(async ({ model }: { model: string }) => {
      if (model === PRIMARY) throw rateLimit();
      return goodReply;
    });

    await developerReceivesAISecurityExplanations(input);

    expect(mockRecordFallback).toHaveBeenCalledTimes(1);
    expect(mockRecordFallback).toHaveBeenCalledWith(
      expect.objectContaining({ fromModel: PRIMARY, toModel: SECONDARY, reason: "rate_limit" }),
    );
  });

  it("does not cache an answer produced by the fallback model", async () => {
    mockGenerate.mockImplementation(async ({ model }: { model: string }) => {
      if (model === PRIMARY) throw rateLimit();
      return goodReply;
    });

    await developerReceivesAISecurityExplanations(input);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("returns a graceful message when every model is rate-limited", async () => {
    mockGenerate.mockImplementation(async () => {
      throw rateLimit();
    });

    const result = await developerReceivesAISecurityExplanations(input);

    expect(result.explanation).toContain("rate limit");
    expect(result.explanation).not.toMatch(/\n\s+at /);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("does not write an audit event when the primary model succeeds", async () => {
    mockGenerate.mockResolvedValue(goodReply);

    await developerReceivesAISecurityExplanations(input);

    expect(mockRecordFallback).not.toHaveBeenCalled();
  });

  it("fails fast and falls back to static template when model circuit breaker is tripped (#1768)", async () => {
    tripModelCircuitBreaker(PRIMARY);
    tripModelCircuitBreaker(SECONDARY);

    const result = await developerReceivesAISecurityExplanations(input);

    expect(result.explanation).toContain("circuit breaker");
    expect(result.explanation).toContain("OPEN");
    expect(result.remediationSuggestions).toContain("Circuit breaker active");
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
