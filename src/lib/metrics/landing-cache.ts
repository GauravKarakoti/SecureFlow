/**
 * A TTL cache with single-flight, for the public landing metrics (#705).
 *
 * `/api/metrics/landing` is unauthenticated, `force-dynamic`, and every hit
 * fans out into eight `COUNT(*)` aggregates across the four largest tables in
 * the schema. The route advertised `Cache-Control: public, s-maxage=60`, but
 * `force-dynamic` means the framework never caches the response, so that header
 * only helps if a CDN happens to sit in front. Nothing protected the database.
 *
 * The numbers are a decorative strip on a marketing page. Recomputing them per
 * request buys nothing, and the endpoint being the one route in the repository
 * with no rate limit made "per request" as often as anyone cared to ask.
 *
 * Two properties matter, and the second is the one that is easy to miss:
 *
 *  1. **TTL.** A hit inside the window costs nothing.
 *  2. **Single flight.** Concurrent *misses* share one in-flight promise rather
 *     than each starting their own fan-out. A plain TTL cache with no
 *     single-flight is at its most useless exactly when it is needed most: the
 *     moment the entry expires under load, every concurrent request misses
 *     together and they all query at once.
 *
 * In-process on purpose. This is a decorative counter with no correctness
 * requirement; the worst case of a cold cache is one extra fan-out, which is
 * what we have today on every single request. A Redis-backed cache would add a
 * dependency and a failure mode to something whose worst case is already fine.
 * Same reasoning as `src/lib/heist/transmission-cache.ts`.
 */

/** How long a computed value stays servable. */
export const DEFAULT_METRICS_TTL_MS = 60_000;

export interface TtlCacheOptions {
  ttlMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface CacheState<T> {
  value: T;
  expiresAt: number;
}

/**
 * Wrap `load` so repeated calls inside the TTL reuse one result.
 *
 * A rejection is never cached: a transient database error would otherwise be
 * served for the whole window, turning one bad moment into a minute of bad
 * responses. The in-flight promise is cleared on failure so the next caller
 * retries immediately.
 *
 * A stale value is *not* served on failure either. That would be a reasonable
 * design for a cache whose freshness does not matter, but it would also mean a
 * landing page quietly showing minute-old numbers with no way for the caller to
 * tell — and `LandingStats.isLive` already exists to answer that question
 * honestly.
 */
export function createTtlCache<T>(
  load: () => Promise<T>,
  options: TtlCacheOptions = {}
): {
  get: () => Promise<T>;
  peek: () => T | null;
  invalidate: () => void;
  readonly inFlight: boolean;
} {
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_METRICS_TTL_MS);
  const now = options.now ?? Date.now;

  let state: CacheState<T> | null = null;
  let pending: Promise<T> | null = null;

  const isFresh = (): boolean => state !== null && state.expiresAt > now();

  return {
    async get(): Promise<T> {
      if (isFresh()) return (state as CacheState<T>).value;

      // Single flight: the second concurrent miss joins the first one's promise
      // rather than starting a second fan-out.
      if (pending) return pending;

      pending = load()
        .then((value) => {
          state = { value, expiresAt: now() + ttlMs };
          return value;
        })
        .finally(() => {
          // Cleared on success and on failure alike, so a rejection is not
          // latched for the rest of the window.
          pending = null;
        });

      return pending;
    },

    /** The cached value if it is still fresh, without triggering a load. */
    peek(): T | null {
      return isFresh() ? (state as CacheState<T>).value : null;
    },

    /** Drop the cached value. Test seam, and useful after a known write. */
    invalidate(): void {
      state = null;
    },

    get inFlight(): boolean {
      return pending !== null;
    },
  };
}
