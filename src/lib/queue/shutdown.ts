import { Worker } from 'bullmq';
import { redis, closeQueueRedis } from './redis';

export interface GracefulShutdownOptions {
  workers?: Worker[];
  /**
   * Anything else that has to be drained before Redis closes.
   *
   * `workers` takes BullMQ `Worker` instances and calls `close()` on each.
   * `scanWorkerPool` is not a `Worker` — it wraps one privately and exposes
   * `stop()` — so it could not be passed here at all, and a SIGTERM would have
   * closed the two webhook workers, closed Redis, and exited with a scan
   * mid-flight still holding its BullMQ lock. That job then waits out
   * `lockDuration` (ten minutes) before anything can pick it up again (#750).
   *
   * A list of functions rather than a second list of objects, so a caller can
   * hand over anything that needs draining without this module having to know
   * its shape.
   */
  drain?: Array<() => Promise<void>>;
  timeoutMs?: number;
  onShutdownComplete?: () => void;
}

let isShuttingDown = false;

/**
 * Returns whether a graceful shutdown sequence is currently in progress.
 */
export function isWorkerShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Reset the shutdown flag (primarily used in tests).
 */
export function resetShutdownState(): void {
  isShuttingDown = false;
}

/**
 * Gracefully close workers, drain active jobs, close Redis connection, and exit process safely.
 */
export async function gracefulShutdown(
  signal: string,
  options: GracefulShutdownOptions = {}
): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Shutdown] Shutdown already in progress. Ignoring duplicate signal (${signal}).`);
    return;
  }

  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);

  const { workers = [], drain = [], timeoutMs = 10000, onShutdownComplete } = options;

  const shutdownPromise = (async () => {
    // 1. Close all BullMQ workers to stop accepting new jobs and wait for active jobs to finish
    if (workers.length > 0) {
      console.log(`[Shutdown] Closing ${workers.length} BullMQ worker(s)...`);
      await Promise.allSettled(
        workers.map(async (w) => {
          try {
            if (w && typeof w.close === 'function') {
              await w.close();
            }
          } catch (err: any) {
            console.error(`[Shutdown] Error closing worker:`, err?.message || err);
          }
        })
      );
      console.log('[Shutdown] All BullMQ workers closed.');
    }

    // 1b. Drain anything that is not a bare Worker — the scan worker pool, in
    // particular. Settled independently and before Redis closes, so one that
    // throws cannot skip the rest or leave the connection open.
    if (drain.length > 0) {
      console.log(`[Shutdown] Draining ${drain.length} additional worker(s)...`);
      await Promise.allSettled(
        drain.map(async (stop) => {
          try {
            await stop();
          } catch (err: any) {
            console.error('[Shutdown] Error draining worker:', err?.message || err);
          }
        })
      );
      console.log('[Shutdown] Additional workers drained.');
    }

    // 2. Close queue redis connection
    console.log('[Shutdown] Closing Redis connection...');
    await closeQueueRedis();
    console.log('[Shutdown] Redis connection closed.');

    if (onShutdownComplete) {
      onShutdownComplete();
    }
  })();

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn(`[Shutdown] Graceful shutdown timed out after ${timeoutMs}ms. Forcing shutdown.`);
      resolve();
    }, timeoutMs);
  });

  await Promise.race([shutdownPromise, timeoutPromise]);
  console.log('[Shutdown] Graceful shutdown sequence completed.');
}

/**
 * Register signal handlers (SIGINT, SIGTERM) for graceful worker shutdown.
 */
export function setupWorkerSignalHandlers(options: GracefulShutdownOptions = {}): void {
  const handleSignal = async (signal: string) => {
    await gracefulShutdown(signal, options);
    // If not running in test environment, exit the process
    if (process.env.NODE_ENV !== 'test') {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => {
    void handleSignal('SIGINT');
  });

  process.once('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });
}
