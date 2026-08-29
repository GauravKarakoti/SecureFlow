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
}

export interface StreamManagerStats {
  activeConnections: number;
  totalRegistered: number;
  totalCleanedUp: number;
  oldestConnectionMs: number | null;
}

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

  /**
   * Register a new SSE connection.
   *
   * @param upstreamSignal - The client's request signal (e.g. `req.signal`).
   *   When this signal fires, the connection is automatically unregistered and
   *   the internal AbortController is aborted.
   * @param label - Optional label for debugging.
   * @returns A connection ID and the AbortController to pass to background work.
   */
  register(
    upstreamSignal?: AbortSignal,
    label?: string
  ): { id: ConnectionId; signal: AbortSignal } {
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

    // When the upstream signal fires, clean up
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        // Already aborted — clean up immediately
        this.cleanup(id);
      } else {
        upstreamSignal.addEventListener(
          'abort',
          () => this.cleanup(id),
          { once: true }
        );
      }
    }

    return { id, signal: abortController.signal };
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

    // Abort the controller if not already aborted
    if (!conn.abortController.signal.aborted) {
      conn.abortController.abort();
    }

    this.connections.delete(id);
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
  const { signal, id } = streamManager.register(upstreamSignal, label);
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
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
        streamManager.unregister(id);
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
      streamManager.unregister(id);
    },
  });
}
