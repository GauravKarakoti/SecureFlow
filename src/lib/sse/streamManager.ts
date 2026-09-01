/**
 * SSE Stream Manager — Active client connection registry.
 *
 * Tracks connected SSE clients and manages their lifecycle via AbortControllers.
 * When a client disconnects (browser tab closed, network drop, navigation away),
 * the associated AbortController fires, allowing background work (LLM streaming,
 * long computations) to be cancelled immediately.
 *
 * Usage:
 *   import { streamManager } from '@/lib/sse/streamManager';
 *
 *   const id = streamManager.register(req.signal);
 *   // ... do work ...
 *   streamManager.unregister(id);
 *
 *   // Check stats
 *   const stats = streamManager.getStats();
 */

/** Unique identifier for a tracked connection. */
export type ConnectionId = string;

export interface TrackedConnection {
  id: ConnectionId;
  /** When the connection was registered. */
  registeredAt: number;
  /** Optional label for debugging (e.g. route name, user ID). */
  label?: string;
  /** The AbortController that fires when the client disconnects. */
  abortController: AbortController;
  /** The original upstream signal (if any) that triggered cleanup. */
  upstreamSignal?: AbortSignal;
  /**
   * Detaches the upstream `abort` listener.
   *
   * Held so `cleanup` can remove the listener it added. Without this the
   * closure stays on the signal's listener list for the life of the signal,
   * and a caller registering repeatedly against one long-lived signal
   * accumulates them (#722).
   */
  detachUpstream?: () => void;
}

export interface StreamManagerStats {
  activeConnections: number;
  totalRegistered: number;
  totalCleanedUp: number;
  /** Connections dropped to stay under `maxConnections`. */
  totalEvicted: number;
  /** Connections dropped by the idle sweep. */
  totalReaped: number;
  oldestConnectionMs: number | null;
}

export interface StreamManagerOptions {
  /**
   * Hard cap on tracked connections. Registering past it evicts the oldest.
   *
   * A cap is not a substitute for correct cleanup; it is what stops one
   * missed `release()` from growing without limit in a process that stays up
   * for weeks.
   */
  maxConnections?: number;
  /**
   * How long a connection may sit before the sweep drops it.
   *
   * Sized well above any legitimate stream: SSE responses here run in seconds,
   * so an hour-old entry is a leak rather than a slow client.
   */
  maxAgeMs?: number;
}

/** A registration, and the one call that ends it. */
export interface Registration {
  id: ConnectionId;
  signal: AbortSignal;
  /**
   * Unregister and abort. Idempotent, and safe to call from a `finally`.
   *
   * Handed back so cleanup does not have to be gated behind a caller's own
   * flag. In both SSE routes `finish()` opened with `if (closed) return`, and
   * a failed `enqueue` sets `closed` without unregistering -- after which
   * every later `finish()` returned at the guard and the entry was never
   * released (#722).
   */
  release: () => void;
}

/** Default cap. Far above any real concurrent load on one instance. */
export const DEFAULT_MAX_CONNECTIONS = 10_000;

/** Default idle ceiling: one hour. */
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * In-memory registry of active SSE connections.
 *
 * Each entry owns an AbortController. When the client's upstream signal
 * fires (disconnect, timeout, navigation), the controller is aborted and
 * the entry is cleaned up. This prevents orphaned background work from
 * holding resources.
 */
export class StreamManager {
  private connections = new Map<ConnectionId, TrackedConnection>();
  private nextId = 1;
  private totalRegistered = 0;
  private totalCleanedUp = 0;
  private totalEvicted = 0;
  private totalReaped = 0;
  private readonly maxConnections: number;
  private readonly maxAgeMs: number;

  constructor(options: StreamManagerOptions = {}) {
    this.maxConnections = Math.max(1, options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    this.maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  }

  /**
   * Register a new SSE connection.
   *
   * @param upstreamSignal - The client's request signal (e.g. `req.signal`).
   *   When this signal fires, the connection is automatically unregistered and
   *   the internal AbortController is aborted.
   * @param label - Optional label for debugging.
   * @returns A connection ID and the AbortController to pass to background work.
   */
  register(upstreamSignal?: AbortSignal, label?: string): Registration {
    // Swept here rather than on a timer: a `setInterval` in a module-level
    // singleton keeps the Node process alive and is a leak of the same kind
    // this class is meant to prevent. Registration is the only moment the
    // registry grows, so it is the only moment a sweep is needed.
    this.reapExpired();
    this.enforceCapacity();

    const id = `sse-${this.nextId++}`;
    const abortController = new AbortController();

    const connection: TrackedConnection = {
      id,
      registeredAt: Date.now(),
      label,
      abortController,
      upstreamSignal,
    };

    this.connections.set(id, connection);
    this.totalRegistered++;

    const release = () => this.cleanup(id);

    // When the upstream signal fires, clean up
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        // Already aborted — clean up immediately
        this.cleanup(id);
      } else {
        const onAbort = () => this.cleanup(id);
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
        // Kept so `cleanup` can detach it. `{ once: true }` only removes the
        // listener once it has *fired*; a connection that ends normally would
        // otherwise leave it attached for the life of the signal.
        connection.detachUpstream = () =>
          upstreamSignal.removeEventListener('abort', onAbort);
      }
    }

    return { id, signal: abortController.signal, release };
  }

  /**
   * Drop connections older than `maxAgeMs`.
   *
   * Exposed so a health endpoint or a test can force a sweep; `register`
   * already calls it.
   *
   * Insertion order is registration order, so the scan can stop at the first
   * entry young enough to keep -- it does not walk the whole map.
   */
  reapExpired(now: number = Date.now()): number {
    let reaped = 0;

    for (const conn of this.connections.values()) {
      if (now - conn.registeredAt < this.maxAgeMs) break;
      this.cleanup(conn.id);
      this.totalReaped++;
      reaped++;
    }

    return reaped;
  }

  /** Evict oldest-first until there is room for one more registration. */
  private enforceCapacity(): void {
    while (this.connections.size >= this.maxConnections) {
      const oldest = this.connections.keys().next();
      if (oldest.done) return;
      this.cleanup(oldest.value);
      this.totalEvicted++;
    }
  }

  /**
   * Unregister a connection and abort its controller.
   *
   * Safe to call multiple times or with an unknown ID.
   */
  unregister(id: ConnectionId): void {
    this.cleanup(id);
  }

  /**
   * Get the AbortController for a connection.
   *
   * Useful if you need to manually abort a connection (e.g. server shutdown).
   */
  getController(id: ConnectionId): AbortController | undefined {
    return this.connections.get(id)?.abortController;
  }

  /**
   * Get the AbortSignal for a connection.
   */
  getSignal(id: ConnectionId): AbortSignal | undefined {
    return this.connections.get(id)?.abortController.signal;
  }

  /**
   * Check if a connection is still active.
   */
  isActive(id: ConnectionId): boolean {
    const conn = this.connections.get(id);
    return conn !== undefined && !conn.abortController.signal.aborted;
  }

  /**
   * Get statistics about tracked connections.
   */
  getStats(): StreamManagerStats {
    let oldestMs: number | null = null;
    for (const conn of this.connections.values()) {
      const age = Date.now() - conn.registeredAt;
      if (oldestMs === null || age > oldestMs) {
        oldestMs = age;
      }
    }

    return {
      activeConnections: this.connections.size,
      totalRegistered: this.totalRegistered,
      totalCleanedUp: this.totalCleanedUp,
      totalEvicted: this.totalEvicted,
      totalReaped: this.totalReaped,
      oldestConnectionMs: oldestMs,
    };
  }

  /**
   * Get all active connection IDs (for debugging / monitoring).
   */
  getActiveIds(): ConnectionId[] {
    return [...this.connections.keys()];
  }

  /**
   * Abort and clean up all active connections.
   *
   * Used during graceful server shutdown.
   */
  abortAll(): void {
    for (const id of this.connections.keys()) {
      this.cleanup(id);
    }
  }

  private cleanup(id: ConnectionId): void {
    const conn = this.connections.get(id);
    if (!conn) return;

    // Delete first, so a `cleanup` re-entered from an abort listener finds
    // nothing and returns at the guard above instead of counting twice.
    this.connections.delete(id);

    // Detach before aborting: the upstream listener is no longer wanted, and
    // leaving it attached is what pinned closures to long-lived signals.
    conn.detachUpstream?.();
    conn.detachUpstream = undefined;

    // Abort the controller if not already aborted
    if (!conn.abortController.signal.aborted) {
      conn.abortController.abort();
    }

    this.totalCleanedUp++;
  }
}

/**
 * Singleton stream manager instance.
 *
 * Import this to share the connection registry across the application.
 */
export const streamManager = new StreamManager();

/**
 * Create a disconnect-aware ReadableStream wrapper.
 *
 * Wraps any async generator into an SSE ReadableStream that aborts when the
 * client disconnects. Handles the common pattern of streaming SSE events while
 * monitoring for disconnection.
 *
 * @param generator - An async generator that yields SSE event objects.
 * @param upstreamSignal - The client's request abort signal.
 * @param label - Optional label for the connection.
 * @returns A ReadableStream that can be returned from a Next.js route handler.
 */
export function createManagedStream<T extends Record<string, unknown>>(
  generator: (signal: AbortSignal) => AsyncIterable<T>,
  upstreamSignal?: AbortSignal,
  label?: string
): ReadableStream<Uint8Array> {
  const { signal, release } = streamManager.register(upstreamSignal, label);
  const encoder = new TextEncoder();

  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: T): void => {
        if (closed || signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      const finish = (): void => {
        // `release()` is unconditional: `closed` guards double-closing the
        // controller, which is a different question from whether the registry
        // still holds the entry. Gating both on one flag is how a failed
        // `enqueue` -- which sets `closed` on its own -- left connections
        // registered forever (#722).
        release();

        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };

      if (signal.aborted) {
        finish();
        return;
      }

      try {
        for await (const event of generator(signal)) {
          if (closed || signal.aborted) {
            finish();
            return;
          }
          send(event);

          // Check terminal events
          if (
            (event as Record<string, unknown>).type === 'done' ||
            (event as Record<string, unknown>).type === 'error'
          ) {
            finish();
            return;
          }
        }

        // Generator ended without terminal event
        if (!signal.aborted) {
          finish();
        }
      } catch (err) {
        if (signal.aborted) {
          finish();
          return;
        }

        const message = err instanceof Error ? err.message : 'Unknown streaming error.';
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`)
          );
        } catch {}
        finish();
      }
    },

    cancel() {
      closed = true;
      release();
    },
  });
}
