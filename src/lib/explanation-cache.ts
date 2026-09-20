import { createHash } from "crypto";
import { redis } from "@/lib/redis";

const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export interface CachedExplanation {
  explanation: string;
  remediationSuggestions: string;
  promptInjectionSuspected: boolean;
}

export function createExplanationCacheKey(input: {
  findingType: string;
  severity: string;
  fileLocation: string;
  codeSnippet: string;
}): string {
  const normalized = JSON.stringify({
    findingType: input.findingType,
    severity: input.severity,
    fileLocation: input.fileLocation,
    codeSnippet: input.codeSnippet,
  });

  const hash = createHash("sha256").update(normalized).digest("hex");

  return `ai-explanation:${hash}`;
}

export async function getCachedExplanation(key: string): Promise<CachedExplanation | null> {
  if (!redis) return null;

  try {
    const cached = await redis.get(key);

    if (!cached) return null;

    return JSON.parse(cached) as CachedExplanation;
  } catch (error) {
    console.warn("[AI_CACHE] Failed to read cache:", error);
    return null;
  }
}

export async function setCachedExplanation(key: string, result: CachedExplanation): Promise<void> {
  if (!redis) return;

  try {
    await redis.set(key, JSON.stringify(result), "EX", CACHE_TTL_SECONDS);
  } catch (error) {
    console.warn("[AI_CACHE] Failed to write cache:", error);
  }
}
