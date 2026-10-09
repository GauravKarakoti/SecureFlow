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
 */

import prisma from "@/lib/prisma";
import { redis } from "@/lib/redis";

/** TTL for cached policy lists. 5 minutes balances freshness and DB load. */
export const POLICY_CACHE_TTL_SECONDS = 300;

/** Redis key for a user's active policy list. */
export function policyCacheKey(userId: string): string {
  return `policy:active:${userId}`;
}

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

  // --- Cache miss: fetch from DB ---
  const policies = await fetchPoliciesFromDb(userId);

  // --- Cache write (best-effort) ---
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(policies), "EX", POLICY_CACHE_TTL_SECONDS);
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
  try {
    await redis.del(policyCacheKey(userId));
  } catch {
    // Non-fatal: the TTL will expire the stale entry naturally
  }
}
