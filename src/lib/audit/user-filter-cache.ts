/**
 * Short-lived per-user cache for the audit-log filter dropdowns (#659).
 *
 * The sibling of `src/lib/admin/audit-filter-cache.ts`, which #645 added for
 * `/admin/logs`. The user-facing `/dashboard/audit` was left on the original
 * shape: two `findMany({ distinct })` calls with no `take` and no cache, run on
 * every render to produce a list of a dozen strings.
 *
 * The difference from the admin cache is that this one is keyed by user, so it
 * needs a bound of its own — an unbounded map keyed by user id is a leak in a
 * long-lived server process, and the thing being cached is a dropdown. Entries
 * are evicted oldest-first once the cap is reached.
 *
 * In-process, so each server instance warms its own copy. The worst case of a
 * cold or stale entry is a user not seeing a brand-new action name in their
 * filter list for up to a minute; the logs themselves are never cached.
 *
 * Kept out of `src/lib/actions/audit.ts` because that file is `"use server"`:
 * every export there must be an async server action, so it cannot hold module
 * state or a synchronous reset seam.
 */

/** How long a filter list stays servable. */
export const USER_FILTER_CACHE_TTL_MS = 60_000;

/**
 * How many users' filter lists are held at once.
 *
 * Each entry is two short string arrays. A few hundred is far more than any
 * single instance has concurrently active and still negligible in memory terms.
 */
export const USER_FILTER_CACHE_MAX_ENTRIES = 500;

export interface UserAuditFilters {
  actions: string[];
  decisions: string[];
}

interface CachedEntry extends UserAuditFilters {
  expiresAt: number;
}

const cache = new Map<string, CachedEntry>();

/** Injectable clock. Swapped by tests; there is no reason to change it at runtime. */
let clock: () => number = Date.now;

/** Read a user's cached filter lists, or `null` when cold or stale. */
export function readCachedUserFilters(userId: string): UserAuditFilters | null {
  const entry = cache.get(userId);
  if (!entry) return null;

  if (entry.expiresAt <= clock()) {
    cache.delete(userId);
    return null;
  }

  // Re-inserting keeps the Map's insertion order acting as a recency order, so
  // eviction drops the least recently *used* entry rather than the oldest one
  // written.
  cache.delete(userId);
  cache.set(userId, entry);

  // Copies, so a caller sorting or splicing the result cannot mutate the cache.
  return { actions: [...entry.actions], decisions: [...entry.decisions] };
}

/** Drop entries that have expired, then evict by age until under the cap. */
function makeRoom(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  while (cache.size >= USER_FILTER_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Store a freshly derived pair of filter lists for a user. */
export function writeCachedUserFilters(userId: string, filters: UserAuditFilters): void {
  const now = clock();

  if (!cache.has(userId)) makeRoom(now);

  cache.set(userId, {
    actions: [...filters.actions],
    decisions: [...filters.decisions],
    expiresAt: now + USER_FILTER_CACHE_TTL_MS,
  });
}

/**
 * Drop one user's entry.
 *
 * Called from the write paths that can introduce an action or decision this
 * user has not produced before.
 */
export function invalidateCachedUserFilters(userId: string): void {
  cache.delete(userId);
}

/** Current number of cached users. Test seam and diagnostics. */
export function cachedUserCount(): number {
  return cache.size;
}

/** Test seam: swap the clock and clear whatever is held. */
export function __setUserFilterClockForTests(next: () => number = Date.now): void {
  clock = next;
  cache.clear();
}

/**
 * Pull one column's distinct values out of a `groupBy` result.
 *
 * The generalised form of `actionsFromGroups` in `src/lib/admin/queries.ts`,
 * which only knows about `action`. Nulls and empty strings are dropped —
 * `decision` is nullable, and a filter option the user cannot select is worse
 * than no option — and the result is deduped and sorted so the dropdown order
 * does not depend on how Postgres happened to return the groups.
 */
export function valuesFromGroups(
  groups: Array<Record<string, unknown>>,
  column: string
): string[] {
  const values = groups
    .map((group) => group[column])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
