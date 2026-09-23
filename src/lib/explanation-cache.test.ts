import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("@/lib/redis", () => ({
  redis: mockRedis,
}));

import {
  createExplanationCacheKey,
  getCachedExplanation,
  setCachedExplanation,
} from "./explanation-cache";

describe("explanation cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the same key for identical findings", () => {
    const input = {
      findingType: "SQL_INJECTION",
      severity: "HIGH",
      fileLocation: "src/db.ts:10",
      codeSnippet: "query(userInput)",
    };

    expect(createExplanationCacheKey(input)).toBe(createExplanationCacheKey(input));
  });

  it("creates different keys when the code changes", () => {
    const base = {
      findingType: "SQL_INJECTION",
      severity: "HIGH",
      fileLocation: "src/db.ts:10",
      codeSnippet: "query(userInput)",
    };

    const changed = {
      ...base,
      codeSnippet: "query(sanitizedInput)",
    };

    expect(createExplanationCacheKey(base)).not.toBe(createExplanationCacheKey(changed));
  });

  it("returns a cached explanation on a cache hit", async () => {
    const cached = {
      explanation: "SQL injection detected.",
      remediationSuggestions: "Use parameterized queries.",
      promptInjectionSuspected: false,
    };

    mockRedis.get.mockResolvedValue(JSON.stringify(cached));

    const result = await getCachedExplanation("ai-explanation:test");

    expect(result).toEqual(cached);
    expect(mockRedis.get).toHaveBeenCalledWith("ai-explanation:test");
  });

  it("returns null on a cache miss", async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await getCachedExplanation("ai-explanation:missing");

    expect(result).toBeNull();
  });

  it("stores an explanation with a TTL", async () => {
    const result = {
      explanation: "SQL injection detected.",
      remediationSuggestions: "Use parameterized queries.",
      promptInjectionSuspected: false,
    };

    await setCachedExplanation("ai-explanation:test", result);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "ai-explanation:test",
      JSON.stringify(result),
      "EX",
      86400,
    );
  });
});
