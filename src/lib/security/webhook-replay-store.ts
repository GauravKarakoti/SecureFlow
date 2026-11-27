import crypto from "node:crypto";

/**
 * Bounded TTL Nonce & Delivery-ID Anti-Replay Store (#2188).
 *
 * Prevents within-window webhook replay attacks by tracking seen delivery IDs
 * or signature digests with TTL expiration and O(1) Map insertion-order
 * bounded eviction (zero background setInterval timers).
 */

export const DEFAULT_REPLAY_STORE_MAX_ENTRIES = 50_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface ReplayStoreOptions {
  maxEntries?: number;
  sweepIntervalMs?: number;
}

export interface NonceConsumeResult {
  accepted: boolean;
  reason?: string;
  expiresAt?: number;
}

export class WebhookReplayStore {
  private readonly seen = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;

  constructor(options: ReplayStoreOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_REPLAY_STORE_MAX_ENTRIES);
    this.sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
    this.lastSweepAt = 0;
  }

  /**
   * Opportunistically drops expired nonces on the write path.
   */
  sweepExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
        removed++;
      }
    }
    this.lastSweepAt = now;
    return removed;
  }

  /**
   * Atomically checks and records a nonce/delivery key for `ttlSeconds`.
   * Returns `{ accepted: false }` if the key is still live within its TTL window.
   */
  consume(nonceKey: string, ttlSeconds: number, now: number = Date.now()): NonceConsumeResult {
    const cleanKey = nonceKey.trim();
    if (!cleanKey) {
      return { accepted: false, reason: "Empty replay nonce key" };
    }

    if (now - this.lastSweepAt >= this.sweepIntervalMs) {
      this.sweepExpired(now);
    }

    const existingExpiry = this.seen.get(cleanKey);
    if (existingExpiry !== undefined) {
      if (existingExpiry > now) {
        return {
          accepted: false,
          reason: "Replay detected: duplicate webhook delivery within replay window",
          expiresAt: existingExpiry,
        };
      }
      // Expired entry: delete before re-inserting at MRU/FIFO tail
      this.seen.delete(cleanKey);
    }

    // Evict oldest entry in O(1) if capacity ceiling is reached
    if (this.seen.size >= this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) {
        this.seen.delete(oldestKey);
      }
    }

    const ttlMs = Math.max(1, ttlSeconds) * 1000;
    const expiresAt = now + ttlMs;
    this.seen.set(cleanKey, expiresAt);

    return { accepted: true, expiresAt };
  }
}

/** Shared bounded anti-replay store for inbound webhook admission. */
export const defaultWebhookReplayStore = new WebhookReplayStore();

/**
 * Derives a deterministic anti-replay key from an explicit delivery ID or
 * falls back to a SHA-256 digest of signature + timestamp + payload.
 */
export function deriveWebhookReplayKey(
  signatureHeader: string,
  timestampHeader: string,
  deliveryId?: string | null,
): string {
  if (deliveryId && deliveryId.trim().length > 0) {
    return `delivery:${deliveryId.trim()}`;
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${timestampHeader.trim()}|${signatureHeader.trim()}`)
    .digest("hex");
  return `sig:${digest}`;
}

export function consumeWebhookNonce(
  nonceKey: string,
  ttlSeconds: number,
  now: number = Date.now(),
  store: WebhookReplayStore = defaultWebhookReplayStore,
): NonceConsumeResult {
  return store.consume(nonceKey, ttlSeconds, now);
}
