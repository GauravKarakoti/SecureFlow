import { redis } from "./redis";
import { v4 as uuidv4 } from "uuid";

/**
 * Attempts to acquire a distributed lock.
 * Returns a unique lock token if successful, or null if the lock is already held.
 *
 * The lock is a lease: it expires after `ttlMs` unless it is renewed. For work
 * with no fixed upper bound, keep it alive with `startLockHeartbeat` rather than
 * picking a TTL long enough to outlast the slowest run.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  // Mock DB environments do not use Redis
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    return `mock-lock-token-${Date.now()}`;
  }

  const token = uuidv4();
  // NX: Only set the key if it does not already exist.
  // PX: Set the specified expire time, in milliseconds.
  const result = await redis.set(key, token, "PX", ttlMs, "NX");

  if (result === "OK") {
    return token;
  }
  return null;
}

/**
 * Extends the lease on a lock this caller still owns.
 *
 * Compare-and-extend runs as one Lua script, so a lease that already expired and
 * was taken by someone else is never extended on their behalf.
 *
 * Resolves `false` when the lock is no longer ours (expired or taken over) and
 * rejects when Redis could not be reached. The two mean different things: after
 * a rejection the lease may well still be valid.
 */
export async function extendLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    return true;
  }

  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  const result = await redis.eval(script, 1, key, token, ttlMs);
  return result === 1;
}

/**
 * Releases a distributed lock using the unique token.
 * A Lua script ensures that the lock is only deleted if the token matches,
 * preventing accidental deletion of a lock held by another process if it expired.
 */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    return true;
  }

  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  try {
    const result = await redis.eval(script, 1, key, token);
    return result === 1;
  } catch (error) {
    console.error(`[RedisLock] Error releasing lock for key ${key}:`, error);
    return false;
  }
}

export interface LockHeartbeat {
  /** Stop renewing. Safe to call more than once. Call before `releaseLock`. */
  stop(): void;
  /** True once a renewal found the lock no longer ours. */
  readonly lost: boolean;
}

/**
 * Keeps a lock's lease alive while the work it guards is still running.
 *
 * Renews every `intervalMs` (default: a third of the lease, so two renewals can
 * fail before the lease lapses). This lets the lease stay short, which is what
 * bounds how long a crashed holder blocks everyone else, while a slow run is
 * still protected for as long as it actually takes.
 *
 * - A renewal that reports the lock is gone marks the heartbeat `lost`, stops it
 *   and calls `onLost`. The work cannot be un-run, so this is for visibility.
 * - A renewal that fails because Redis is unreachable is logged and retried on
 *   the next tick; the lease may still be valid.
 * - The timer is `unref`'d so a heartbeat never keeps the process alive.
 */
export function startLockHeartbeat(
  key: string,
  token: string,
  ttlMs: number,
  intervalMs: number = Math.floor(ttlMs / 3),
  onLost?: () => void,
): LockHeartbeat {
  if (!(intervalMs > 0 && intervalMs < ttlMs)) {
    throw new RangeError(
      `Lock heartbeat interval (${intervalMs}ms) must be positive and shorter than the lease (${ttlMs}ms)`,
    );
  }

  let stopped = false;
  let lost = false;
  let inFlight = false;

  const timer = setInterval(async () => {
    // A slow Redis must not stack up overlapping renewals.
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      const extended = await extendLock(key, token, ttlMs);
      // `stopped` again: stop() may have been called while this was in flight, in
      // which case the lock was released on purpose and is not "lost".
      if (!extended && !stopped) {
        lost = true;
        stopped = true;
        clearInterval(timer);
        console.error(`[RedisLock] Lost the lock for key ${key} while still holding it.`);
        onLost?.();
      }
    } catch (error) {
      console.warn(`[RedisLock] Could not renew the lock for key ${key}, will retry:`, error);
    } finally {
      inFlight = false;
    }
  }, intervalMs);

  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    get lost() {
      return lost;
    },
  };
}
