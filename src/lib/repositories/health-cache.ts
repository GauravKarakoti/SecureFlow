/**
 * Short-lived per-user cache for the Repositories overview aggregates (#1870).
 *
 * Indexed queries compute repository health aggregates (open findings,
 * 30-day blocked PRs, median resolution times, and 8-week trend points).
 * Caching them briefly (60s TTL) avoids repetitive database round-trips
 * when filtering, sorting, or paginating through repositories.
 *
 * Mirrors the LRU bounded cache pattern in `src/lib/audit/user-filter-cache.ts`.
 */

import type { RepositoryHealthItem, RepositoriesOverviewData } from "./types";

export const REPO_HEALTH_CACHE_TTL_MS = 60_000;
export const REPO_HEALTH_CACHE_MAX_ENTRIES = 500;

interface CachedEntry {
  data: RepositoriesOverviewData;
  expiresAt: number;
}

const cache = new Map<string, CachedEntry>();

let clock: () => number = Date.now;

/** Read a user's cached repository overview data, or null when cold or expired. */
export function readCachedRepoHealth(userId: string): RepositoriesOverviewData | null {
  const entry = cache.get(userId);
  if (!entry) return null;

  if (entry.expiresAt <= clock()) {
    cache.delete(userId);
    return null;
  }

  // Refresh LRU recency
  cache.delete(userId);
  cache.set(userId, entry);

  return {
    ...entry.data,
    repositories: entry.data.repositories.map((r) => ({
      ...r,
      openFindings: { ...r.openFindings },
      trend: r.trend.map((t) => ({ ...t })),
    })),
  };
}

/** Store freshly derived repository overview data. */
export function writeCachedRepoHealth(userId: string, data: RepositoriesOverviewData): void {
  if (cache.size >= REPO_HEALTH_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(userId, {
    data: {
      ...data,
      repositories: data.repositories.map((r) => ({
        ...r,
        openFindings: { ...r.openFindings },
        trend: r.trend.map((t) => ({ ...t })),
      })),
    },
    expiresAt: clock() + REPO_HEALTH_CACHE_TTL_MS,
  });
}

/** Invalidate cache for a user (e.g. after a new scan or triage action). */
export function invalidateCachedRepoHealth(userId: string): void {
  cache.delete(userId);
}

/** Clear entire cache. Useful for test isolation. */
export function clearAllCachedRepoHealth(): void {
  cache.clear();
}

/** Test seam: swap clock and clear entries. */
export function __setClockForTests(next: () => number = Date.now): void {
  clock = next;
  cache.clear();
}
