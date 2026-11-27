/**
 * Fair Queue Scheduler — Round-robin scheduling with per-installation concurrency limits.
 *
 * Prevents a single installation from monopolizing worker capacity when opening many PRs at once
 * (e.g., bulk dependency updates or monorepo releases). Schedules waiting jobs round-robin across
 * installations, enforces per-installation concurrency limits (default 2), preserves strict per-PR
 * ordering and locking, and provides real-time per-installation queue depth telemetry.
 *
 * Usage:
 *   import { fairQueueScheduler, resolveInstallationConcurrencyLimit } from "@/lib/queue/fair-scheduler";
 */

import {
  BackpressureController,
  type BackpressureConfig,
  type BackpressureDecision,
  type BackpressureState,
  type JobPriority,
} from "./backpressure";

export const DEFAULT_INSTALLATION_CONCURRENCY_LIMIT = 2;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Resolve the per-installation concurrency limit from environment variables.
 * Checks SCAN_INSTALLATION_CONCURRENCY_LIMIT, then INSTALLATION_CONCURRENCY_LIMIT,
 * falling back to DEFAULT_INSTALLATION_CONCURRENCY_LIMIT (2).
 */
export function resolveInstallationConcurrencyLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SCAN_INSTALLATION_CONCURRENCY_LIMIT ?? env.INSTALLATION_CONCURRENCY_LIMIT;
  if (!raw) return DEFAULT_INSTALLATION_CONCURRENCY_LIMIT;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1 || !isFinite(parsed)) {
    return DEFAULT_INSTALLATION_CONCURRENCY_LIMIT;
  }
  return parsed;
}

export interface FairJob<T = unknown> {
  id: string;
  installationId: string | number;
  repositoryFullName: string;
  prNumber: number;
  priority?: JobPriority;
  data?: T;
  enqueuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  attemptsMade?: number;
  maxAttempts?: number;
  status?: "waiting" | "active" | "completed" | "failed" | "dead_letter";
  error?: string;
}

export interface Clock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => any;
  clearTimeout: (id: any) => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export interface FairSchedulerOptions {
  /** Maximum concurrent running jobs per installation (default: 2 or from env). */
  concurrencyLimit?: number;
  /** Global worker capacity / total concurrent running jobs across all installations. */
  totalConcurrencyLimit?: number;
  /** Clock interface for virtual/fake timers in testing. */
  clock?: Clock;
  /** Handler invoked when a job is dispatched to execute. */
  executor?: (job: FairJob) => Promise<unknown>;
  /** Callback invoked when a job exhausts all attempts and routes to DLQ. */
  onDeadLetter?: (job: FairJob, error: Error) => Promise<void> | void;
  /** Backoff delay before retrying a failed job (in ms). */
  retryDelayMs?: number;
  /** Optional adaptive backpressure configuration for admission control. */
  backpressure?: Partial<BackpressureConfig>;
}

export class FairQueueScheduler {
  private concurrencyLimit: number;
  private totalConcurrencyLimit: number;
  private clock: Clock;
  private executor?: (job: FairJob) => Promise<unknown>;
  private onDeadLetter?: (job: FairJob, error: Error) => Promise<void> | void;
  private retryDelayMs: number;

  /** Waiting jobs partitioned by installation ID in arrival order. */
  private waitingByInstallation = new Map<string, FairJob[]>();

  /** Active job IDs per installation ID. */
  private activeByInstallation = new Map<string, Set<string>>();

  /** Set of active PR keys ("${repo}#${prNumber}") currently running. */
  private activePrs = new Set<string>();

  /** Active jobs map for quick lookup: jobId -> FairJob. */
  private activeJobs = new Map<string, FairJob>();

  /** Deduplication index: tracks known job IDs that are waiting or active. */
  private knownJobIds = new Set<string>();

  /** Round-robin rotation list of installation IDs. */
  private installationOrder: string[] = [];

  /** Last installation that was dispatched, used to rotate round-robin turns fairly. */
  private lastDispatchedInstallation: string | null = null;

  /** Completed jobs history. */
  private completedJobs: FairJob[] = [];

  /** Dead-letter queue entries. */
  private deadLetterJobs: FairJob[] = [];

  /** Adaptive backpressure controller for queue admission control. */
  private backpressureController: BackpressureController;

  constructor(options: FairSchedulerOptions = {}) {
    this.concurrencyLimit = options.concurrencyLimit ?? resolveInstallationConcurrencyLimit();
    this.totalConcurrencyLimit = options.totalConcurrencyLimit ?? Infinity;
    this.clock = options.clock ?? systemClock;
    this.executor = options.executor;
    this.onDeadLetter = options.onDeadLetter;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.backpressureController = new BackpressureController(options.backpressure);
  }

  /**
   * Helper to format the PR key for locking and ordering.
   */
  public getPrKey(repositoryFullName: string, prNumber: number): string {
    return `${repositoryFullName}#${prNumber}`;
  }

  /**
   * Enqueue a job into the fair scheduler.
   *
   * Deduplicates by job ID: if a job with the same ID is already waiting or active,
   * it is not added again.
   *
   * Returns true if enqueued, false if deduplicated.
   */
  public enqueue(job: FairJob, options: { replaceExisting?: boolean } = {}): boolean {
    const instKey = String(job.installationId);

    if (this.knownJobIds.has(job.id)) {
      if (!options.replaceExisting) {
        return false;
      }
      this.removeJobFromWaiting(job.id);
    }

    this.knownJobIds.add(job.id);

    const queuedJob: FairJob = {
      ...job,
      enqueuedAt: job.enqueuedAt ?? this.clock.now(),
      status: "waiting",
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };

    if (!this.waitingByInstallation.has(instKey)) {
      this.waitingByInstallation.set(instKey, []);
    }
    this.waitingByInstallation.get(instKey)!.push(queuedJob);

    if (!this.installationOrder.includes(instKey)) {
      this.installationOrder.push(instKey);
    }

    this.dispatch();
    return true;
  }

  /**
   * Dispatch eligible waiting jobs according to fair round-robin scheduling.
   *
   * Iterates through installations in round-robin order.
   * For each installation:
   * - Enforces the per-installation concurrency limit.
   * - Respects per-PR locking: if a scan for a PR is active, subsequent jobs for that PR wait.
   * - Preserves per-PR FIFO ordering: never runs a later job for a PR ahead of an earlier one.
   * - Dispatches immediately when an eligible job is found, then moves round-robin pointer.
   */
  public dispatch(): FairJob[] {
    const dispatched: FairJob[] = [];

    while (this.getTotalActive() < this.totalConcurrencyLimit) {
      if (this.installationOrder.length === 0) {
        break;
      }

      let startIndex = 0;
      if (this.lastDispatchedInstallation) {
        const lastIdx = this.installationOrder.indexOf(this.lastDispatchedInstallation);
        if (lastIdx !== -1) {
          startIndex = (lastIdx + 1) % this.installationOrder.length;
        }
      }

      let scheduledInThisPass = false;
      const numInstallations = this.installationOrder.length;

      for (let i = 0; i < numInstallations; i++) {
        const instIndex = (startIndex + i) % numInstallations;
        const instKey = this.installationOrder[instIndex];

        const waitingQueue = this.waitingByInstallation.get(instKey);
        if (!waitingQueue || waitingQueue.length === 0) {
          continue;
        }

        const activeCount = this.activeByInstallation.get(instKey)?.size ?? 0;
        if (activeCount >= this.concurrencyLimit) {
          continue;
        }

        const seenPrsForInstallation = new Set<string>();
        let eligibleIndex = -1;

        for (let j = 0; j < waitingQueue.length; j++) {
          const candidate = waitingQueue[j];
          const prKey = this.getPrKey(candidate.repositoryFullName, candidate.prNumber);

          // If a job for this PR is currently running, cannot run in parallel
          if (this.activePrs.has(prKey)) {
            seenPrsForInstallation.add(prKey);
            continue;
          }

          // If an earlier job for this PR is still waiting ahead in the queue,
          // never reorder: this later job must wait for the earlier one
          if (seenPrsForInstallation.has(prKey)) {
            continue;
          }

          // Eligible head-of-line job found!
          eligibleIndex = j;
          break;
        }

        if (eligibleIndex !== -1) {
          const [jobToRun] = waitingQueue.splice(eligibleIndex, 1);
          const prKey = this.getPrKey(jobToRun.repositoryFullName, jobToRun.prNumber);

          // Track active state
          if (!this.activeByInstallation.has(instKey)) {
            this.activeByInstallation.set(instKey, new Set());
          }
          this.activeByInstallation.get(instKey)!.add(jobToRun.id);
          this.activePrs.add(prKey);
          this.activeJobs.set(jobToRun.id, jobToRun);

          jobToRun.status = "active";
          jobToRun.startedAt = this.clock.now();
          dispatched.push(jobToRun);

          // Advance round-robin pointer
          this.lastDispatchedInstallation = instKey;
          scheduledInThisPass = true;

          // Trigger execution if executor provided
          if (this.executor) {
            this.executeJob(jobToRun);
          }

          break; // restart outer loop to re-evaluate capacity
        }
      }

      if (!scheduledInThisPass) {
        break; // No eligible jobs can be scheduled at this time
      }
    }

    return dispatched;
  }

  private executeJob(job: FairJob): void {
    Promise.resolve()
      .then(() => this.executor!(job))
      .then(
        () => this.completeJob(job.id),
        (err) => this.failJob(job.id, err instanceof Error ? err : new Error(String(err))),
      );
  }

  /**
   * Mark an active job as completed.
   * Releases the installation concurrency slot and the per-PR lock,
   * then triggers dispatch for waiting jobs.
   */
  public completeJob(jobId: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    const instKey = String(job.installationId);
    const prKey = this.getPrKey(job.repositoryFullName, job.prNumber);

    this.activeJobs.delete(jobId);
    this.activeByInstallation.get(instKey)?.delete(jobId);
    this.activePrs.delete(prKey);
    this.knownJobIds.delete(jobId);

    job.status = "completed";
    job.completedAt = this.clock.now();
    this.completedJobs.push(job);

    this.dispatch();
  }

  /**
   * Handle job failure.
   * Releases the active slot and per-PR lock immediately.
   * If attempts remain, re-queues the job (preserving PR ordering ahead of newer jobs for that PR).
   * If attempts are exhausted, moves the job to the Dead Letter Queue.
   */
  public failJob(jobId: string, error: Error): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    const instKey = String(job.installationId);
    const prKey = this.getPrKey(job.repositoryFullName, job.prNumber);

    this.activeJobs.delete(jobId);
    this.activeByInstallation.get(instKey)?.delete(jobId);
    this.activePrs.delete(prKey);

    job.attemptsMade = (job.attemptsMade ?? 0) + 1;
    job.error = error.message;

    const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    if (job.attemptsMade < maxAttempts) {
      job.status = "waiting";

      const reinsert = () => {
        if (!this.waitingByInstallation.has(instKey)) {
          this.waitingByInstallation.set(instKey, []);
        }
        const queue = this.waitingByInstallation.get(instKey)!;

        // Re-insert before any newer job for the SAME PR to preserve order
        const firstSamePrIndex = queue.findIndex(
          (q) => this.getPrKey(q.repositoryFullName, q.prNumber) === prKey,
        );

        if (firstSamePrIndex !== -1) {
          queue.splice(firstSamePrIndex, 0, job);
        } else {
          // If no other job for this PR, place at front to resume soon
          queue.unshift(job);
        }

        if (!this.installationOrder.includes(instKey)) {
          this.installationOrder.push(instKey);
        }

        this.dispatch();
      };

      if (this.retryDelayMs > 0) {
        this.clock.setTimeout(() => reinsert(), this.retryDelayMs);
      } else {
        reinsert();
      }
    } else {
      // Attempts exhausted: route to Dead Letter Queue
      job.status = "dead_letter";
      this.knownJobIds.delete(jobId);
      this.deadLetterJobs.push(job);

      if (this.onDeadLetter) {
        try {
          this.onDeadLetter(job, error);
        } catch (dlqErr) {
          console.error("[FairQueueScheduler] Failed to route to DLQ:", dlqErr);
        }
      }

      this.dispatch();
    }
  }

  /**
   * Helper to remove a waiting job from an installation queue.
   */
  private removeJobFromWaiting(jobId: string): void {
    for (const [instKey, queue] of this.waitingByInstallation.entries()) {
      const idx = queue.findIndex((j) => j.id === jobId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        this.knownJobIds.delete(jobId);
        break;
      }
    }
  }

  /**
   * Return the waiting queue depth per installation.
   * Maps installationId -> count of waiting jobs.
   */
  public getQueueDepthPerInstallation(): Record<string, number> {
    const depths: Record<string, number> = {};
    for (const [inst, queue] of this.waitingByInstallation.entries()) {
      if (queue.length > 0) {
        depths[inst] = queue.length;
      }
    }
    return depths;
  }

  /**
   * Return the count of active running jobs per installation.
   */
  public getActivePerInstallation(): Record<string, number> {
    const active: Record<string, number> = {};
    for (const [inst, set] of this.activeByInstallation.entries()) {
      if (set.size > 0) {
        active[inst] = set.size;
      }
    }
    return active;
  }

  /**
   * Total number of currently waiting jobs across all installations.
   */
  public getTotalWaiting(): number {
    let total = 0;
    for (const queue of this.waitingByInstallation.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Total number of currently running jobs across all installations.
   */
  /**
   * Evaluate adaptive backpressure and enqueue a job only if admitted.
   */
  public enqueueWithBackpressure(
    job: FairJob,
    options: { replaceExisting?: boolean; latencyP95Ms?: number } = {},
  ): {
    enqueued: boolean;
    deduplicated: boolean;
    decision: BackpressureDecision;
  } {
    const instKey = String(job.installationId);
    const installationDepth = this.waitingByInstallation.get(instKey)?.length ?? 0;
    const decision = this.backpressureController.evaluateAdmission({
      priority: job.priority,
      currentDepth: this.getTotalWaiting(),
      installationDepth,
      latencyP95Ms: options.latencyP95Ms,
    });

    if (!decision.admitted) {
      return { enqueued: false, deduplicated: false, decision };
    }

    const enqueued = this.enqueue(job, { replaceExisting: options.replaceExisting });
    return { enqueued, deduplicated: !enqueued, decision };
  }

  /**
   * Current backpressure state and utilization ratio for the scheduler.
   */
  public getBackpressureStatus(latencyP95Ms?: number): {
    state: BackpressureState;
    utilization: number;
    metrics: { admittedCount: number; shedCount: number };
  } {
    const { state, utilization } = this.backpressureController.getState(
      this.getTotalWaiting(),
      latencyP95Ms,
    );
    return {
      state,
      utilization,
      metrics: this.backpressureController.getMetrics(),
    };
  }

  public getTotalActive(): number {
    return this.activeJobs.size;
  }

  public getInstallationConcurrencyLimit(): number {
    return this.concurrencyLimit;
  }

  public setInstallationConcurrencyLimit(limit: number): void {
    this.concurrencyLimit = limit;
    this.dispatch();
  }

  public getCompletedJobs(): FairJob[] {
    return [...this.completedJobs];
  }

  public getDeadLetterJobs(): FairJob[] {
    return [...this.deadLetterJobs];
  }

  public getActiveJob(jobId: string): FairJob | undefined {
    return this.activeJobs.get(jobId);
  }

  public clear(): void {
    this.waitingByInstallation.clear();
    this.activeByInstallation.clear();
    this.activePrs.clear();
    this.activeJobs.clear();
    this.knownJobIds.clear();
    this.installationOrder = [];
    this.lastDispatchedInstallation = null;
    this.completedJobs = [];
    this.deadLetterJobs = [];
  }
}

/**
 * Global singleton fair queue scheduler.
 */
export const fairQueueScheduler = new FairQueueScheduler();
