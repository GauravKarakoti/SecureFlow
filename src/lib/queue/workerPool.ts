/**
 * Worker Pool — Manages concurrent scan processing with concurrency limits.
 *
 * Controls how many vulnerability scans run simultaneously to prevent
 * resource exhaustion. Each scan processes file chunks in parallel within
 * its allocated concurrency slot.
 *
 * Usage:
 *   import { scanWorkerPool } from '@/lib/queue/workerPool';
 *   scanWorkerPool.start();   // Start processing jobs
 *   scanWorkerPool.stop();    // Graceful shutdown
 */

import { Worker, Job, UnrecoverableError } from 'bullmq';
import { redis } from './redis';
import { scanDLQ, type ScanJobData, updateScanJobProgress } from './scanQueue';
import { processScanJob } from '@/lib/scanner/scanEngine';
import {
  InvalidInstallationIdError,
  ScanPersistenceError,
  scanJobCompletion,
} from '@/lib/scanner/scan-persistence';

/** Maximum concurrent scans. Avoids overwhelming the LLM API and DB connection pool. */
const DEFAULT_CONCURRENCY = 3;

/** Maximum time a single scan job can run before being timed out. */
const SCAN_JOB_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * How often the queue is checked for jobs whose lock has lapsed.
 *
 * Was passed under `settings`, where BullMQ v5 does not read it — `stalledInterval`
 * is a top-level `WorkerOptions` field and `AdvancedOptions` has no such
 * property, which is what `tsc` was reporting. The value was therefore ignored
 * and the default 30 s applied, against a `lockDuration` of ten minutes.
 */
const STALLED_CHECK_INTERVAL_MS = 60_000;

export interface WorkerPoolOptions {
  concurrency?: number;
  jobTimeoutMs?: number;
}

/**
 * Scan Worker Pool
 *
 * Wraps a BullMQ Worker with concurrency control and lifecycle management.
 * Handles job completion, failure, and DLQ routing.
 */
class ScanWorkerPool {
  private worker: Worker<ScanJobData> | null = null;
  private running = false;
  private readonly concurrency: number;

  constructor(concurrency: number = DEFAULT_CONCURRENCY) {
    this.concurrency = concurrency;
  }

  /**
   * Start the worker pool.
   *
   * Begins processing scan jobs from the queue with the configured concurrency.
   */
  start(): void {
    if (this.running) {
      console.warn('[WorkerPool] Already running');
      return;
    }

    this.worker = new Worker<ScanJobData>(
      'vulnerability-scans',
      async (job: Job<ScanJobData>) => {
        return await this.processJob(job);
      },
      {
        connection: redis as any,
        concurrency: this.concurrency,
        lockDuration: SCAN_JOB_TIMEOUT_MS,
        lockRenewTime: 30_000, // Renew lock every 30s
        stalledInterval: STALLED_CHECK_INTERVAL_MS,
        maxStalledCount: 1,
      }
    );

    this.worker.on('completed', (job) => {
      console.log(`[WorkerPool] Job ${job.id} completed for ${job.data.repositoryFullName}#${job.data.prNumber}`);
    });

    this.worker.on('failed', async (job, err) => {
      console.error(`[WorkerPool] Job ${job?.id} failed:`, err.message);

      // Route to DLQ on permanent failure
      if (job && job.attemptsMade >= (job.opts.attempts ?? 2)) {
        console.warn(`[WorkerPool] Routing job ${job.id} to DLQ after ${job.attemptsMade} attempts`);
        try {
          await scanDLQ.add('failed-scan', {
            ...job.data,
            error: err.message,
          } as any);
        } catch (dlqErr) {
          // An `async` listener's rejection is an unhandled rejection, which
          // under Node's default policy takes the worker process down — so a
          // Redis blip while recording a failed job would stop every other scan
          // in flight. Logged and dropped instead.
          console.error(`[WorkerPool] Failed to route job ${job.id} to DLQ:`, dlqErr);
        }
      }
    });

    this.worker.on('error', (err) => {
      console.error('[WorkerPool] Worker error:', err);
    });

    this.running = true;
    console.log(`[WorkerPool] Started with concurrency=${this.concurrency}`);
  }

  /**
   * Gracefully stop the worker pool.
   *
   * Waits for active jobs to complete before shutting down.
   */
  async stop(): Promise<void> {
    if (!this.worker || !this.running) {
      return;
    }

    console.log('[WorkerPool] Stopping...');
    await this.worker.close();
    this.worker = null;
    this.running = false;
    console.log('[WorkerPool] Stopped');
  }

  /**
   * Check if the worker pool is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current concurrency setting.
   */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Process a single scan job.
   */
  private async processJob(job: Job<ScanJobData>): Promise<{ scanJobId: string }> {
    const { scanJobId } = job.data;

    console.log(`[WorkerPool] Processing scan job ${job.id} (${job.data.repositoryFullName}#${job.data.prNumber})`);

    // Mark as processing
    await updateScanJobProgress(scanJobId, {
      status: 'PROCESSING',
      startedAt: new Date(),
    });

    // Report initial progress
    await job.updateProgress({ phase: 'starting', scannedFiles: 0 });

    try {
      const result = await processScanJob(job.data, (progress) => {
        // Update job progress for BullMQ monitoring
        job.updateProgress(progress).catch(() => {});
      });

      // Mark as completed. The decision goes through `scanJobCompletion`, which
      // maps the scanner's verdict onto a `PolicyDecision` member — writing
      // `'REVIEW REQUIRED'` here is what made this update throw, and the catch
      // below then marked a perfectly good scan FAILED and re-ran it (#747).
      await updateScanJobProgress(scanJobId, scanJobCompletion(result));

      return { scanJobId };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      // Mark as failed
      await updateScanJobProgress(scanJobId, {
        status: 'FAILED',
        error: errorMessage,
        completedAt: new Date(),
      }).catch(() => {});

      // Two failures are worth failing on the first pass rather than after the
      // full retry chain, following the same reasoning as `outboundWorker`:
      //
      //  - a malformed installation id will be exactly as malformed next time;
      //  - a persistence failure happens *after* the check run and the PR
      //    comment have already been posted, so retrying duplicates both while
      //    repeating the LLM spend, and cannot fix a rejected write.
      if (err instanceof ScanPersistenceError || err instanceof InvalidInstallationIdError) {
        throw new UnrecoverableError(errorMessage);
      }

      throw err;
    }
  }
}

// --- Singleton ---

export const scanWorkerPool = new ScanWorkerPool(
  parseInt(process.env.SCAN_WORKER_CONCURRENCY ?? '3', 10)
);

/**
 * Convenience: start the scan worker pool.
 */
export function startScanWorker(): void {
  scanWorkerPool.start();
}

/**
 * Convenience: stop the scan worker pool gracefully.
 */
export async function stopScanWorker(): Promise<void> {
  await scanWorkerPool.stop();
}
