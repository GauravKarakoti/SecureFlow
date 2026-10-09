import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  EXPLANATION_PROMPT_VERSION,
  createExplanationCacheKey,
  getCacheTtlSeconds,
  getCachedExplanation,
  getModelId,
  setCachedExplanation,
} from "./explanation-cache";

const baseInput = {
  findingType: "SQL_INJECTION",
  severity: "HIGH",
  fileLocation: "src/db.ts:10",
  codeSnippet: "query(userInput)",
  model: "groq/llama-3.1-8b-instant",
};

const sampleResult = {
  explanation: "SQL injection detected.",
  remediationSuggestions: "Use parameterized queries.",
  promptInjectionSuspected: false,
};

describe("explanation cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LLM_CACHE_TTL_SECONDS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.LLM_CACHE_TTL_SECONDS;
  });

  describe("cache key", () => {
    it("creates the same key for identical findings", () => {
      expect(createExplanationCacheKey(baseInput)).toBe(createExplanationCacheKey(baseInput));
    });

    it("creates different keys when the code changes", () => {
      const changed = { ...baseInput, codeSnippet: "query(sanitizedInput)" };

      expect(createExplanationCacheKey(baseInput)).not.toBe(createExplanationCacheKey(changed));
    });

    it("creates different keys when the model changes", () => {
      const changed = { ...baseInput, model: "groq/llama-3.3-70b-versatile" };

      expect(createExplanationCacheKey(baseInput)).not.toBe(createExplanationCacheKey(changed));
    });

    it("creates different keys when the prompt version changes", () => {
      const changed = { ...baseInput, promptVersion: "v2" };

      expect(createExplanationCacheKey(baseInput)).not.toBe(createExplanationCacheKey(changed));
    });

    it("includes the prompt version in the key prefix", () => {
      expect(createExplanationCacheKey(baseInput)).toMatch(
        new RegExp(`^ai-explanation:${EXPLANATION_PROMPT_VERSION}:[a-f0-9]{64}$`),
      );
    });
  });

  describe("getModelId", () => {
    it("handles string and object model references", () => {
      expect(getModelId("groq/llama")).toBe("groq/llama");
      expect(getModelId({ name: "groq/llama" })).toBe("groq/llama");
      expect(getModelId(undefined)).toBe("unknown");
    });
  });

  describe("cache hit and miss", () => {
    it("returns a cached explanation on a cache hit", async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(sampleResult));

      const result = await getCachedExplanation("ai-explanation:test");

      expect(result).toEqual(sampleResult);
      expect(mockRedis.get).toHaveBeenCalledWith("ai-explanation:test");
    });

    it("returns null on a cache miss", async () => {
      mockRedis.get.mockResolvedValue(null);

      expect(await getCachedExplanation("ai-explanation:missing")).toBeNull();
    });

    it("returns null once the entry has expired in Redis", async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(sampleResult));
      mockRedis.get.mockResolvedValueOnce(null); // Redis dropped the key after its TTL

      expect(await getCachedExplanation("ai-explanation:ttl")).toEqual(sampleResult);
      expect(await getCachedExplanation("ai-explanation:ttl")).toBeNull();
    });
  });

  describe("TTL", () => {
    it("defaults to 24 hours", async () => {
      await setCachedExplanation("ai-explanation:test", sampleResult);

      expect(mockRedis.set).toHaveBeenCalledWith(
        "ai-explanation:test",
        JSON.stringify(sampleResult),
        "EX",
        86400,
      );
    });

    it("reads the TTL from LLM_CACHE_TTL_SECONDS", async () => {
      process.env.LLM_CACHE_TTL_SECONDS = "120";

      await setCachedExplanation("ai-explanation:test", sampleResult);

      expect(mockRedis.set).toHaveBeenCalledWith(
        "ai-explanation:test",
        JSON.stringify(sampleResult),
        "EX",
        120,
      );
    });

    it("falls back to the default for invalid values", () => {
      for (const bad of ["abc", "0", "-5", ""]) {
        process.env.LLM_CACHE_TTL_SECONDS = bad;
        expect(getCacheTtlSeconds()).toBe(86400);
      }
    });
  });

  describe("Redis failures", () => {
    it("returns null when a Redis read fails", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockRedis.get.mockRejectedValue(new Error("connection refused"));

      expect(await getCachedExplanation("ai-explanation:test")).toBeNull();
    });

    it("does not throw when a Redis write fails", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockRedis.set.mockRejectedValue(new Error("connection refused"));

      await expect(
        setCachedExplanation("ai-explanation:test", sampleResult),
      ).resolves.toBeUndefined();
    });

    it("returns null when Redis reads hang past the timeout", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      mockRedis.get.mockReturnValue(new Promise(() => {})); // never resolves

      const pending = getCachedExplanation("ai-explanation:slow");
      await vi.advanceTimersByTimeAsync(600);

      expect(await pending).toBeNull();
    });

    it("does not hang when Redis writes hang past the timeout", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      mockRedis.set.mockReturnValue(new Promise(() => {}));

      const pending = setCachedExplanation("ai-explanation:slow", sampleResult);
      await vi.advanceTimersByTimeAsync(600);

      await expect(pending).resolves.toBeUndefined();
    });
  });
});
