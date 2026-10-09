import { createHash } from "crypto";
import { redis } from "@/lib/redis";

/**
 * Bump this whenever SYSTEM_PROMPT or buildPrompt() changes, so cached
 * explanations generated with the old prompt are no longer served.
 */
export const EXPLANATION_PROMPT_VERSION = "v1";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const REDIS_TIMEOUT_MS = 500;

export interface CachedExplanation {
  explanation: string;
  remediationSuggestions: string;
  promptInjectionSuspected: boolean;
}

export interface ExplanationCacheKeyInput {
  findingType: string;
  severity: string;
  fileLocation: string;
  codeSnippet: string;
  description?: string;
  /** Model identifier used to generate the explanation (see getModelId). */
  model: string;
  /** Defaults to EXPLANATION_PROMPT_VERSION. */
  promptVersion?: string;
}

/**
 * Reads the cache TTL from LLM_CACHE_TTL_SECONDS.
 * Falls back to 24 hours when unset, non-numeric, or not positive.
 */
export function getCacheTtlSeconds(): number {
  const raw = process.env.LLM_CACHE_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

/**
 * Turns a Genkit model reference (string or object with a `name`) into a
 * plain string usable in a cache key.
 */
export function getModelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "name" in model) {
    const name = (model as { name: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis call timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createExplanationCacheKey(input: ExplanationCacheKeyInput): string {
  const promptVersion = input.promptVersion ?? EXPLANATION_PROMPT_VERSION;

  const normalized = JSON.stringify({
    findingType: input.findingType,
    severity: input.severity,
    fileLocation: input.fileLocation,
    codeSnippet: input.codeSnippet,
    description: input.description ?? "",
    model: input.model,
    promptVersion,
  });

  const hash = createHash("sha256").update(normalized).digest("hex");

  return `ai-explanation:${promptVersion}:${hash}`;
}

export async function getCachedExplanation(key: string): Promise<CachedExplanation | null> {
  if (!redis) return null;

  try {
    const cached = await withTimeout(redis.get(key), REDIS_TIMEOUT_MS);

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
    await withTimeout(
      redis.set(key, JSON.stringify(result), "EX", getCacheTtlSeconds()),
      REDIS_TIMEOUT_MS,
    );
  } catch (error) {
    console.warn("[AI_CACHE] Failed to write cache:", error);
  }
}
