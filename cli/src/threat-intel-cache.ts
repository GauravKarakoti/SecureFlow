import { Redis } from "ioredis";

const CACHE_PREFIX = "secureflow:threat-intel:v1:";
const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_MEMORY_ENTRIES = 100;

interface MemoryEntry {
  value: string;
  expiresAt: number;
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

function getMemoryValue(key: string): string | null {
  const entry = memoryCache.get(key);

  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }

  return entry.value;
}

function setMemoryValue(key: string, value: string, ttlSeconds: number): void {
  for (const [existingKey, entry] of memoryCache) {
    if (entry.expiresAt <= Date.now()) {
      memoryCache.delete(existingKey);
    }
  }

  if (!memoryCache.has(key) && memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;

    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey);
    }
  }

  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function isValidKey(key: string): boolean {
  return typeof key === "string" && key.trim().length > 0 && key.length <= 200;
}

/**
 * Reads cached JSON from Redis, falling back to the local memory cache.
 */
export async function getThreatIntelCache<T>(key: string): Promise<T | null> {
  if (!isValidKey(key)) return null;

  const redisKey = `${CACHE_PREFIX}${key}`;
  const localValue = getMemoryValue(redisKey);

  if (localValue !== null) {
    try {
      return JSON.parse(localValue) as T;
    } catch {
      memoryCache.delete(redisKey);
    }
  }

  try {
    const client = getRedisClient();

    if (client) {
      const value = await client.get(redisKey);

      if (value !== null) {
        setMemoryValue(redisKey, value, DEFAULT_TTL_SECONDS);

        try {
          return JSON.parse(value) as T;
        } catch {
          return null;
        }
      }
    }
  } catch {
    // Redis unavailable: use the local fallback below.
  }

  return null;
}

/**
 * Writes JSON to the local fallback first, then attempts Redis.
 */
export async function setThreatIntelCache<T>(
  key: string,
  value: T,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  if (!isValidKey(key)) return;

  const safeTtl = Number.isFinite(ttlSeconds)
    ? Math.max(1, Math.floor(ttlSeconds))
    : DEFAULT_TTL_SECONDS;

  const redisKey = `${CACHE_PREFIX}${key}`;
  const serialized = JSON.stringify(value);

  if (serialized === undefined) return;

  setMemoryValue(redisKey, serialized, safeTtl);

  try {
    const client = getRedisClient();

    if (client) {
      await client.set(redisKey, serialized, "EX", safeTtl);
    }
  } catch {
    // Keep the local fallback when Redis is unavailable.
  }
}

/**
 * Closes the optional Redis connection during shutdown.
 */
export function closeThreatIntelCache(): void {
  redis?.disconnect();
  redis = null;
  redisInitialized = false;
}
