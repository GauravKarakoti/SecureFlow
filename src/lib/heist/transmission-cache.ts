/**
 * Bounded cache for completed heist transmissions (#643).
 *
 * `/api/heist-transmission` is `force-dynamic` with no caching, so every view of
 * a share link ran a fresh Groq completion. The output depends on exactly four
 * bounded parameters — project name, score, rank, findings count — and is
 * decorative. Two people opening the same link should not cost two completions,
 * and a link that gets any traction should not cost thousands.
 *
 * The per-IP rate limit on the route does not help with this: it bounds one
 * caller, and a share link that circulates is a thousand callers with one
 * request each.
 *
 * In-process on purpose. A Redis-backed cache would survive a restart and be
 * shared across instances, but this is decorative text with no correctness
 * requirement; the failure mode of a cold cache is one extra completion, which
 * is exactly what we have today. Reaching for Redis here would add a dependency
 * and a failure mode to something whose worst case is already acceptable.
 */

/** How long a transmission stays servable. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Entries retained.
 *
 * Bounded so a caller varying `project` on every request cannot turn the cache
 * into an unbounded map — which would convert a cost problem into a memory one.
 */
export const DEFAULT_MAX_ENTRIES = 500;

interface CacheEntry {
  message: string;
  expiresAt: number;
}

export interface TransmissionCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/** The parameter tuple a transmission is a function of. */
export interface TransmissionKeyParts {
  projectName: string;
  score?: number;
  rank?: string;
  findingsCount?: number;
}

/**
 * Build the cache key.
 *
 * Case-folded and NUL-separated: `\0` cannot appear in a normalised project
 * name (the guard strips control characters), so no combination of parameters
 * can collide with a different combination by concatenation.
 */
export function transmissionKey(parts: TransmissionKeyParts): string {
  return [
    parts.projectName.toLowerCase(),
    parts.score ?? '',
    (parts.rank ?? '').toUpperCase(),
    parts.findingsCount ?? '',
  ].join('\0');
}

export class TransmissionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TransmissionCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  /** Live entry count, after expiry. Exposed for tests and diagnostics. */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /**
   * Read a transmission, or `null`.
   *
   * A hit is re-inserted so the Map's insertion order doubles as recency — the
   * eviction below then drops the least recently *used* entry rather than the
   * oldest one, which for a share link that stays popular is the difference
   * between a warm cache and a useless one.
   */
  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.message;
  }

  /** Store a completed transmission. */
  set(key: string, message: string): void {
    if (!message) return;

    this.entries.delete(key);
    this.entries.set(key, { message, expiresAt: this.now() + this.ttlMs });

    this.evictExpired();

    // Map iteration is insertion order, and `get` re-inserts, so the first key
    // is the least recently used.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

let shared: TransmissionCache | null = null;

/** Process-wide cache, created on first use. */
export function getTransmissionCache(): TransmissionCache {
  if (shared === null) shared = new TransmissionCache();
  return shared;
}

/** Drop the process-wide instance. Test seam. */
export function resetTransmissionCache(): void {
  shared?.clear();
  shared = null;
}
