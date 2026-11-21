import { Worker } from "bullmq";
import { redis, closeQueueRedis } from "./redis";
import { getInFlightScanCount, handleInterruptedScans } from "./in-flight-scans";

/**
 * Default internal worker shutdown grace period in milliseconds (#1894).
 * Set to 25s, shorter than typical Kubernetes terminationGracePeriodSeconds (30s-35s)
 * so workers can cleanly finish in-flight scans or handle interrupted check runs before SIGKILL.
 */
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Resolves the effective graceful shutdown timeout in milliseconds.
 * Priority: explicit parameter > WORKER_SHUTDOWN_TIMEOUT_MS env var > DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS.
 */
export function resolveShutdownTimeoutMs(explicitTimeout?: number): number {
  if (typeof explicitTimeout === "number" && !Number.isNaN(explicitTimeout) && explicitTimeout > 0) {
    return explicitTimeout;
  }
  const envVal = process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
}

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
  handleInterruptedScans?: (reason: string) => Promise<void>;
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
 * Gracefully close workers, drain active jobs, close Redis connection, and exit process safely (#1894).
 *
 * Sequence:
 * 1. Pause workers to stop accepting new jobs immediately.
 * 2. Wait for active in-flight scans/jobs to complete within the configured grace period.
 * 3. If timeout expires with scans still in-flight, clean them up: release locks,
 *    mark check runs as neutral/cancelled (never leave in progress), and re-queue jobs.
 * 4. Close Redis connections and invoke completion callbacks.
 */
export async function gracefulShutdown(
  signal: string,
  options: GracefulShutdownOptions = {},
): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Shutdown] Shutdown already in progress. Ignoring duplicate signal (${signal}).`);
    return;
  }

  isShuttingDown = true;
  const timeoutMs = resolveShutdownTimeoutMs(options.timeoutMs);
  console.log(
    `[Shutdown] Received ${signal}. Starting graceful worker shutdown (grace period: ${timeoutMs}ms)...`,
  );

  const {
    workers = [],
    drain = [],
    onShutdownComplete,
    handleInterruptedScans: customHandleInterrupted,
  } = options;

  // Step 1: Stop accepting new jobs immediately across all BullMQ workers
  if (workers.length > 0) {
    console.log(
      `[Shutdown] Step 1/4: Pausing ${workers.length} queue worker(s) to stop taking new jobs...`,
    );
    await Promise.allSettled(
      workers.map(async (w) => {
        try {
          if (w && typeof w.pause === "function") {
            await w.pause(true);
          }
        } catch {
          // Worker may already be paused or closed; ignore
        }
      }),
    );
  }

  // Step 2: Wait for in-flight scans and active jobs to finish within the grace period
  const activeCount = getInFlightScanCount();
  console.log(
    `[Shutdown] Step 2/4: Waiting for in-flight jobs to complete (${activeCount} scan(s) in-flight)...`,
  );

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[Shutdown] Graceful shutdown grace period timed out after ${timeoutMs}ms with in-flight jobs still active.`,
      );
      resolve();
    }, timeoutMs);
  });

  const drainWorkPromise = (async () => {
    // BullMQ workers: close() stops accepting jobs and waits for active jobs to finish
    const workerPromises = workers.map(async (w) => {
      try {
        if (w && typeof w.close === "function") {
          await w.close();
        }
      } catch (err: any) {
        console.error(`[Shutdown] Error closing worker:`, err?.message || err);
      }
    });

    // Drain additional pools (scanWorkerPool, DLQ auto-retry, remediation DLQ)
    const drainPromises = drain.map(async (stop) => {
      try {
        if (typeof stop === "function") {
          await stop();
        }
      } catch (err: any) {
        console.error("[Shutdown] Error draining worker:", err?.message || err);
      }
    });

    await Promise.allSettled([...workerPromises, ...drainPromises]);
  })();

  try {
    await Promise.race([drainWorkPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Step 3: Handle any interrupted in-flight scans that could not finish in time
  const remainingInFlight = getInFlightScanCount();
  if (timedOut || remainingInFlight > 0) {
    console.log(
      `[Shutdown] Step 3/4: Handling ${remainingInFlight} interrupted in-flight scan(s)...`,
    );
    const interruptHandler = customHandleInterrupted ?? handleInterruptedScans;
    await interruptHandler(
      "Worker container was terminated (deployment, restart, or node drain) before the scan could complete. The scan has been re-queued.",
    );
    console.log(
      "[Shutdown] Interrupted scans handled (check runs updated to neutral/cancelled, locks released, jobs re-queued).",
    );
  } else {
    console.log(
      "[Shutdown] Step 3/4: All in-flight scans and jobs completed successfully within grace period.",
    );
  }

  // Step 4: Close Redis connections
  console.log("[Shutdown] Step 4/4: Closing Redis connections...");
  await closeQueueRedis();
  console.log("[Shutdown] Redis connections closed.");

  if (onShutdownComplete) {
    onShutdownComplete();
  }
  console.log("[Shutdown] Graceful shutdown sequence completed.");
}

/**
 * Register signal handlers (SIGINT, SIGTERM) for graceful worker shutdown.
 */
export function setupWorkerSignalHandlers(options: GracefulShutdownOptions = {}): void {
  const handleSignal = async (signal: string) => {
    await gracefulShutdown(signal, options);
    // If not running in test environment, exit the process
    if (process.env.NODE_ENV !== "test") {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void handleSignal("SIGINT");
  });

  process.once("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
}
