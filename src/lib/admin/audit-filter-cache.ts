/**
 * Short-lived cache for the audit-log filter dropdown (#645).
 *
 * The set of distinct `action` values changes only when a new kind of event is
 * written for the first time — a handful of times over the life of the
 * application. Re-deriving it on every render of `/admin/logs`, including every
 * filter change and every page change, is a database round trip for an answer
 * that was correct sixty seconds ago and will still be correct in sixty more.
 *
 * Kept in its own module rather than in `src/lib/actions/admin.ts` because that
 * file is `"use server"`: every export there must be an async server action, so
 * it cannot hold module state helpers or a synchronous reset seam.
 *
 * In-process, so each server instance warms its own copy. That is fine for a
 * dropdown: the worst case of a cold or stale cache is an admin not seeing a
 * brand-new action name in the filter list for up to a minute, and the logs
 * themselves are never cached.
 */

/** How long a filter list stays servable. */
export const FILTER_CACHE_TTL_MS = 60_000;

interface CachedFilters {
  actions: string[];
  expiresAt: number;
}

let cached: CachedFilters | null = null;

/** Injectable clock. Swapped by tests; there is no reason to change it at runtime. */
let clock: () => number = Date.now;

/** Read the cached action list, or `null` when cold or stale. */
export function readCachedActions(): string[] | null {
  if (!cached) return null;
  if (cached.expiresAt <= clock()) {
    cached = null;
    return null;
  }
  // A copy, so a caller sorting or splicing the result cannot mutate the cache.
  return [...cached.actions];
}

/** Store a freshly derived action list. */
export function writeCachedActions(actions: string[]): void {
  cached = { actions: [...actions], expiresAt: clock() + FILTER_CACHE_TTL_MS };
}

/** Drop the cache. Called by the write paths that can introduce a new action. */
export function invalidateCachedActions(): void {
  cached = null;
}

/** Test seam: swap the clock and clear whatever is held. */
export function __setClockForTests(next: () => number = Date.now): void {
  clock = next;
  cached = null;
}
