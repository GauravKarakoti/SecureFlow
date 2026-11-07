/**
 * Redis caching layer for ArmorIQ policy rules (#1183).
 *
 * Fetching policies from Postgres on every scan requires two queries:
 * `policyTemplate.findMany()` and `userPolicyToggle.findMany({ where: { userId } })`.
 * On a busy worker these run for every pull_request delivery, adding latency
 * and unnecessary DB load for data that changes only when a user toggles a rule.
 *
 * This module caches the resolved active-policy list per user in Redis with a
 * configurable TTL (default 5 minutes). A cache miss falls back to Prisma
 * transparently, so the worker is correct whether Redis is available or not.
 *
 * Cache invalidation:
 *   `invalidatePolicyCache(userId)` is called by the policy toggle action
 *   so a user sees their change reflected on the very next scan.
 *
 * Race protection (#1222):
 *   A plain read-through cache has a lost-invalidation race. A scan misses the
 *   cache and reads the OLD policy from Postgres; the user then toggles a rule
 *   (DB commit + cache DEL); the scan finally writes its OLD result back into
 *   Redis, where it would be served for the full TTL. To prevent that, every
 *   user has a small version counter. A reader remembers the version it saw
 *   BEFORE querying Postgres and only stores its result if the counter is still
 *   unchanged (atomically, via a Lua script). `invalidatePolicyCache` bumps the
 *   counter BEFORE deleting the cached value, so any in-flight reader that
 *   started before the update can no longer repopulate the cache.
 */

import prisma from "@/lib/prisma";
import { redis } from "@/lib/redis";

/** TTL for cached policy lists. 5 minutes balances freshness and DB load. */
export const POLICY_CACHE_TTL_SECONDS = 300;

/** How long the per-user version counter is kept after its last bump. */
export const POLICY_VERSION_TTL_SECONDS = 24 * 60 * 60;

/** Redis key for a user's active policy list. */
export function policyCacheKey(userId: string): string {
  return `policy:active:${userId}`;
}

/** Redis key for the per-user counter that guards against stale cache writes. */
export function policyVersionKey(userId: string): string {
  return `policy:ver:${userId}`;
}

/**
 * Atomically store a freshly loaded policy list only if the user's version
 * counter still equals the value the reader saw before it queried Postgres.
 *
 * KEYS[1] = version key, KEYS[2] = cache key
 * ARGV[1] = expected version, ARGV[2] = serialised policies, ARGV[3] = TTL
 *
 * Returns 1 when the value was stored, 0 when it was skipped as stale.
 */
const STORE_IF_VERSION_UNCHANGED = `
local current = redis.call('GET', KEYS[1])
if not current then current = '0' end
if current == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
`;

export interface CachedPolicy {
  id: string;
  name: string;
  description: string;
  severity: string;
  action: string;
  rules: unknown;
  isDefault: boolean;
  isActive: boolean;
}

/**
 * Load active policies for a user, using Redis as a read-through cache.
 *
 * On a cache hit: deserialise and return immediately — no Prisma queries.
 * On a cache miss: run the two Prisma queries, store the result, return it.
 * On a Redis error: fall back to Prisma silently so a Redis outage never
 * blocks a scan.
 */
export async function getActivePoliciesForUser(userId: string): Promise<CachedPolicy[]> {
  const key = policyCacheKey(userId);
  const versionKey = policyVersionKey(userId);

  // --- Cache read ---
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as CachedPolicy[];
      }
    } catch {
      // Redis unavailable — fall through to Prisma
    }
  }

  // Remember the version BEFORE touching Postgres. If an update invalidates the
  // cache while we are reading, the counter moves and our write is dropped.
  let versionBeforeRead: string | null = null;
  if (redis) {
    try {
      versionBeforeRead = (await redis.get(versionKey)) ?? "0";
    } catch {
      // Without a version we cannot safely write; skip caching for this call.
    }
  }

  // --- Cache miss: fetch from DB ---
  const policies = await fetchPoliciesFromDb(userId);

  // --- Cache write (best-effort, only if nothing invalidated us meanwhile) ---
  if (redis && versionBeforeRead !== null) {
    try {
      await redis.eval(
        STORE_IF_VERSION_UNCHANGED,
        2,
        versionKey,
        key,
        versionBeforeRead,
        JSON.stringify(policies),
        String(POLICY_CACHE_TTL_SECONDS),
      );
    } catch {
      // Non-fatal: the caller already has the data
    }
  }

  return policies;
}

/**
 * Fetch and resolve active policies from Postgres.
 *
 * Extracted so it can be called directly in tests without touching Redis.
 */
export async function fetchPoliciesFromDb(userId: string): Promise<CachedPolicy[]> {
  const [templates, userToggles] = await Promise.all([
    prisma.policyTemplate.findMany(),
    prisma.userPolicyToggle.findMany({ where: { userId } }),
  ]);

  const toggleMap = new Map(userToggles.map((t: any) => [t.policyTemplateId, t.isActive]));

  return templates
    .filter((template: any) =>
      toggleMap.has(template.id) ? toggleMap.get(template.id) : template.isDefault,
    )
    .map((template: any) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      severity: template.severity,
      action: template.action,
      rules: template.rules,
      isDefault: template.isDefault,
      isActive: true,
    }));
}

/**
 * Invalidate the cached policy list for a user.
 *
 * Call this whenever a user toggles a policy rule so the next scan picks
 * up the change immediately rather than waiting for the TTL to expire.
 */
export async function invalidatePolicyCache(userId: string): Promise<void> {
  if (!redis) return;

  // Order matters: bump the version first so a reader that is still loading the
  // old policy from Postgres cannot write it back after we delete the entry.
  try {
    const versionKey = policyVersionKey(userId);
    await redis.incr(versionKey);
    await redis.expire(versionKey, POLICY_VERSION_TTL_SECONDS);
  } catch {
    // Non-fatal: still attempt the delete below
  }

  try {
    await redis.del(policyCacheKey(userId));
  } catch {
    // Non-fatal: the TTL will expire the stale entry naturally
  }
}

/**
 * Returns the current policy version for a user from Redis, or '0' if unset/unavailable.
 */
export async function getPolicyVersion(userId: string): Promise<string> {
  if (!redis || !userId) return "0";
  try {
    const ver = await redis.get(policyVersionKey(userId));
    return ver || "0";
  } catch {
    return "0";
  }
}
