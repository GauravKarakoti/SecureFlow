/**
 * Short-lived per-user cache for the Directory Hotspots aggregates (#2018).
 *
 * Indexed queries compute hotspot aggregates (open findings grouped by directory,
 * severity breakdowns, and 30-day trends).
 * Caching them briefly (60s TTL) avoids repetitive database round-trips
 * when filtering, toggling depth, or switching repositories.
 *
 * Mirrors the LRU bounded cache pattern in `src/lib/repositories/health-cache.ts`.
 */

import type { RepoHotspotGroup } from "./hotspots";

export const HOTSPOTS_CACHE_TTL_MS = 60_000;
export const HOTSPOTS_CACHE_MAX_ENTRIES = 500;

interface CachedHotspotsEntry {
  data: RepoHotspotGroup[];
  expiresAt: number;
}

const cache = new Map<string, CachedHotspotsEntry>();

let clock: () => number = Date.now;

/** Read a user's cached hotspots data, or null when cold or expired. */
export function readCachedHotspots(userId: string): RepoHotspotGroup[] | null {
  const entry = cache.get(userId);
  if (!entry) return null;

  if (entry.expiresAt <= clock()) {
    cache.delete(userId);
    return null;
  }

  // Refresh LRU recency
  cache.delete(userId);
  cache.set(userId, entry);

  // Return a shallow clone of the group array
  return entry.data.map((group) => ({
    ...group,
    hotspotsByDepth: Object.fromEntries(
      Object.entries(group.hotspotsByDepth).map(([depth, hotspots]) => [
        depth,
        hotspots.map((h) => ({
          ...h,
          severityCounts: { ...h.severityCounts },
          trend: { ...h.trend },
        })),
      ]),
    ),
  }));
}

/** Store freshly derived hotspots data. */
export function writeCachedHotspots(userId: string, data: RepoHotspotGroup[]): void {
  if (cache.size >= HOTSPOTS_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(userId, {
    data: data.map((group) => ({
      ...group,
      hotspotsByDepth: Object.fromEntries(
        Object.entries(group.hotspotsByDepth).map(([depth, hotspots]) => [
          depth,
          hotspots.map((h) => ({
            ...h,
            severityCounts: { ...h.severityCounts },
            trend: { ...h.trend },
          })),
        ]),
      ),
    })),
    expiresAt: clock() + HOTSPOTS_CACHE_TTL_MS,
  });
}

/** Invalidate hotspots cache for a user. */
export function invalidateCachedHotspots(userId: string): void {
  cache.delete(userId);
}

/** Clear entire hotspots cache. Useful for test isolation. */
export function clearAllCachedHotspots(): void {
  cache.clear();
}

/** Test seam: swap clock and clear entries. */
export function __setHotspotsClockForTests(next: () => number = Date.now): void {
  clock = next;
  cache.clear();
}
