import { Worker } from 'bullmq';
import { redis, closeQueueRedis } from './redis';

export interface GracefulShutdownOptions {
  workers?: Worker[];
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

  const { workers = [], timeoutMs = 10000, onShutdownComplete } = options;

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
