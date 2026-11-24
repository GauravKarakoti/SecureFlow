import { createHash } from "node:crypto";
import { Redis } from "ioredis";

const CACHE_PREFIX = "secureflow:threat-intel:v1:";
export const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour fresh TTL
export const DEFAULT_STALE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days stale fallback window
const MAX_MEMORY_ENTRIES = 100;

export interface ThreatIntelCacheEnvelope<T = unknown> {
  data: T;
  sha256: string;
  cachedAt: number;
  freshUntil: number;
  staleUntil: number;
}

interface MemoryEntry {
  rawEnvelope: string;
  staleUntil: number;
}

const memoryCache = new Map<string, MemoryEntry>();

let redis: Redis | null = null;
let redisInitialized = false;

function getRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL?.trim();

  if (!redisUrl) return null;

  if (!redisInitialized) {
    redisInitialized = true;

    try {
      redis = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1000,
        commandTimeout: 1000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });

      redis.on("error", () => {
        // Redis is optional; callers fall back to memory.
      });
    } catch {
      redis = null;
    }
  }

  return redis;
}

/**
 * Compute SHA-256 hex digest of serialized JSON data payload.
 */
export function computePayloadSha256(data: unknown): string {
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Validate that payload checksum matches the expected SHA-256 hash.
 */
export function verifyPayloadChecksum(data: unknown, expectedSha256: string): boolean {
  if (!expectedSha256 || typeof expectedSha256 !== "string") return false;
  const actualHash = computePayloadSha256(data);
  return actualHash.toLowerCase() === expectedSha256.trim().toLowerCase();
}

function getMemoryEnvelope(key: string, options?: GetThreatIntelCacheOptions): string | null {
  const entry = memoryCache.get(key);

  if (!entry) return null;

  if (entry.staleUntil <= Date.now()) {
    if (options?.allowExpiredFallback) {
      return entry.rawEnvelope;
    }
    memoryCache.delete(key);
    return null;
  }

  return entry.rawEnvelope;
}

function setMemoryEnvelope(
  key: string,
  rawEnvelope: string,
  staleUntil: number,
  options?: GetThreatIntelCacheOptions,
): void {
  if (!options?.allowExpiredFallback) {
    for (const [existingKey, entry] of memoryCache) {
      if (entry.staleUntil <= Date.now()) {
        memoryCache.delete(existingKey);
      }
    }
  }

  if (!memoryCache.has(key) && memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;

    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey);
    }
  }

  memoryCache.set(key, {
    rawEnvelope,
    staleUntil,
  });
}

function isValidKey(key: string): boolean {
  return typeof key === "string" && key.trim().length > 0 && key.length <= 200;
}

export interface SwrCacheResult<T> {
  value: T;
  isStale: boolean;
  sha256: string;
  cachedAt: number;
}

export interface GetThreatIntelCacheOptions {
  allowExpiredFallback?: boolean;
}

/**
 * Reads cached entry with Stale-While-Revalidate (SWR) strategy and SHA-256 checksum verification.
 * Automatically rejects tampered or corrupted cached payloads.
 * Supports serving expired/stale entries when live feed requests time out or fail.
 */
export async function getThreatIntelCacheWithSwr<T>(
  key: string,
  options?: GetThreatIntelCacheOptions,
): Promise<SwrCacheResult<T> | null> {
  if (!isValidKey(key)) return null;

  const redisKey = `${CACHE_PREFIX}${key}`;
  let raw: string | null = getMemoryEnvelope(redisKey, options);

  if (raw === null) {
    try {
      const client = getRedisClient();
      if (client) {
        raw = await client.get(redisKey);
        if (raw !== null) {
          const parsedTemp = JSON.parse(raw) as Partial<ThreatIntelCacheEnvelope<T>>;
          const staleUntil = parsedTemp.staleUntil ?? Date.now() + DEFAULT_STALE_TTL_SECONDS * 1000;
          setMemoryEnvelope(redisKey, raw, staleUntil);
        }
      }
    } catch {
      // Redis unavailable: fallback
    }
  }

  if (raw === null) return null;

  try {
    const envelope = JSON.parse(raw) as ThreatIntelCacheEnvelope<T>;

    if (!envelope || typeof envelope !== "object" || !("data" in envelope) || !envelope.sha256) {
      // Legacy cache without envelope: try direct value
      const legacyData = envelope as unknown as T;
      return {
        value: legacyData,
        isStale: false,
        sha256: computePayloadSha256(legacyData),
        cachedAt: Date.now(),
      };
    }

    // Cryptographic integrity check: verify SHA-256 before deserializing/returning data
    if (!verifyPayloadChecksum(envelope.data, envelope.sha256)) {
      console.warn(
        `⚠️  [SecureFlow Threat Intel] Checksum mismatch for cache key "${key}". Discarding corrupted cache entry.`,
      );
      memoryCache.delete(redisKey);
      try {
        const client = getRedisClient();
        if (client) await client.del(redisKey);
      } catch {
        // ignore
      }
      return null;
    }

    const now = Date.now();
    const isExpired = envelope.staleUntil <= now;
    if (isExpired) {
      if (options?.allowExpiredFallback) {
        console.warn(
          `⚠️  [SecureFlow Threat Intel] Serving expired fallback cache entry for "${key}" due to upstream feed outage.`,
        );
        return {
          value: envelope.data,
          isStale: true,
          sha256: envelope.sha256,
          cachedAt: envelope.cachedAt,
        };
      }
      memoryCache.delete(redisKey);
      return null;
    }

    const isStale = envelope.freshUntil <= now;

    return {
      value: envelope.data,
      isStale,
      sha256: envelope.sha256,
      cachedAt: envelope.cachedAt,
    };
  } catch {
    console.warn(
      "[SecureFlow Threat Intel] Could not deserialize cached threat intelligence. Discarding this memory entry; refresh the feed to recover.",
    );
    memoryCache.delete(redisKey);
    return null;
  }
}

/**
 * Legacy compatibility wrapper: returns null if stale or missing, or returns valid data.
 */
export async function getThreatIntelCache<T>(key: string): Promise<T | null> {
  const res = await getThreatIntelCacheWithSwr<T>(key);
  return res ? res.value : null;
}

/**
 * Writes JSON to cache wrapped in an envelope containing SHA-256 checksum and SWR fresh/stale TTLs.
 */
export async function setThreatIntelCache<T>(
  key: string,
  value: T,
  freshTtlSeconds = DEFAULT_TTL_SECONDS,
  staleTtlSeconds = DEFAULT_STALE_TTL_SECONDS,
): Promise<void> {
  if (!isValidKey(key)) return;

  const safeFreshTtl = Number.isFinite(freshTtlSeconds)
    ? Math.max(1, Math.floor(freshTtlSeconds))
    : DEFAULT_TTL_SECONDS;
  const safeStaleTtl = Number.isFinite(staleTtlSeconds)
    ? Math.max(safeFreshTtl, Math.floor(staleTtlSeconds))
    : Math.max(safeFreshTtl, DEFAULT_STALE_TTL_SECONDS);

  const now = Date.now();
  const sha256 = computePayloadSha256(value);

  const envelope: ThreatIntelCacheEnvelope<T> = {
    data: value,
    sha256,
    cachedAt: now,
    freshUntil: now + safeFreshTtl * 1000,
    staleUntil: now + safeStaleTtl * 1000,
  };

  const redisKey = `${CACHE_PREFIX}${key}`;
  const serialized = JSON.stringify(envelope);

  if (serialized === undefined) return;

  setMemoryEnvelope(redisKey, serialized, envelope.staleUntil);

  try {
    const client = getRedisClient();

    if (client) {
      await client.set(redisKey, serialized, "EX", safeStaleTtl);
    }
  } catch {
    // Keep local fallback
  }
}

/**
 * Internal helper for testing tampered/corrupted cache injections.
 */
export function setThreatIntelCacheEnvelopeRawForTesting(
  rawKey: string,
  rawEnvelope: string,
  staleUntil: number,
): void {
  setMemoryEnvelope(rawKey, rawEnvelope, staleUntil);
}

/**
 * Clear memory cache (useful for testing and reset).
 */
export function clearMemoryThreatIntelCache(): void {
  memoryCache.clear();
}

/**
 * Closes the optional Redis connection during shutdown.
 */
export function closeThreatIntelCache(): void {
  redis?.disconnect();
  redis = null;
  redisInitialized = false;
  memoryCache.clear();
}
