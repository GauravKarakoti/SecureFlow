/**
 * Whether the worker process should consume the `vulnerability-scans` queue (#750).
 *
 * `src/lib/queue/workerPool.ts` defines the worker and exports
 * `scanWorkerPool`, `startScanWorker()` and `stopScanWorker()`. Nothing called
 * any of them:
 *
 * ```
 * $ grep -rn "startScanWorker\|scanWorkerPool" src scripts
 * src/lib/queue/workerPool.ts:180:export const scanWorkerPool = …
 * src/lib/queue/workerPool.ts:187:export function startScanWorker(): void {
 * src/lib/queue/workerPool.ts:195:export async function stopScanWorker(): Promise<void> {
 * ```
 *
 * Definitions only. `scripts/start-worker.ts` — the entry point behind
 * `npm run worker` and the Render worker service — started `worker`
 * (`github-webhooks`) and `outboundWorker` (`outbound-webhooks`) and nothing
 * else, so `vulnerability-scans` had a producer and no consumer. A job enqueued
 * by `POST /api/findings` sat in Redis: the `ScanJob` row never left `PENDING`,
 * the status endpoint reported `progress: 0` forever with no timeout and no
 * terminal state, and `removeOnComplete`/`removeOnFail` never fired, so nothing
 * aged the entries out either.
 *
 * This module holds the decisions that entry point needs, so they can be tested
 * — a worker that is never referenced is not something the suite can notice.
 */

/** Set to a falsey word to run a webhook-only worker process. */
export const SCAN_WORKER_ENABLED_VAR = 'SCAN_WORKER_ENABLED';

/** Concurrency for the scan worker, read by `workerPool`. */
export const SCAN_WORKER_CONCURRENCY_VAR = 'SCAN_WORKER_CONCURRENCY';

/** What `workerPool` falls back to when the variable is unset. */
export const DEFAULT_SCAN_WORKER_CONCURRENCY = 3;

/**
 * Upper bound on concurrency.
 *
 * Each slot holds a Prisma connection and an in-flight LLM request for the
 * length of a scan. The pool and the model quota are the real limits; a number
 * far above them buys nothing and fails in a way that is hard to attribute.
 */
export const MAX_SCAN_WORKER_CONCURRENCY = 32;

/** Words that turn the scan worker off. Everything else leaves it on. */
const DISABLED_WORDS = new Set(['0', 'false', 'no', 'off', 'disabled']);

/**
 * Whether to start the scan worker in this process.
 *
 * Defaults to **on**. The queue having no consumer is the bug; requiring an
 * extra variable to fix it would mean every existing deployment stayed broken
 * after upgrading.
 *
 * The opt-out exists because a deployment may want the webhook workers on one
 * process and the scan pool on another — scans are the long, LLM-bound jobs and
 * webhook deliveries are latency-sensitive.
 */
export function shouldStartScanWorker(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[SCAN_WORKER_ENABLED_VAR];
  if (raw === undefined) return true;

  return !DISABLED_WORDS.has(raw.trim().toLowerCase());
}

/** Thrown when the concurrency variable is present but unusable. */
export class ScanWorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanWorkerConfigError';
  }
}

/**
 * The configured concurrency, validated.
 *
 * `workerPool` builds its singleton with
 * `parseInt(process.env.SCAN_WORKER_CONCURRENCY ?? '3', 10)`, and `parseInt`
 * answers `NaN` for `''` or `'three'`. A `NaN` concurrency is not a loud
 * failure — BullMQ takes it and the worker processes nothing — so a typo in a
 * deployment variable would reproduce exactly the symptom this issue is about,
 * with no error anywhere to explain it.
 *
 * Validated here and thrown at startup, where it is attributable.
 */
export function resolveScanWorkerConcurrency(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[SCAN_WORKER_CONCURRENCY_VAR];

  if (raw === undefined || raw.trim() === '') return DEFAULT_SCAN_WORKER_CONCURRENCY;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ScanWorkerConfigError(
      `${SCAN_WORKER_CONCURRENCY_VAR} must be a positive integer, received: ${JSON.stringify(raw)}`
    );
  }

  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > MAX_SCAN_WORKER_CONCURRENCY) {
    throw new ScanWorkerConfigError(
      `${SCAN_WORKER_CONCURRENCY_VAR} must be between 1 and ${MAX_SCAN_WORKER_CONCURRENCY}, received: ${parsed}`
    );
  }

  return parsed;
}

/** The queues a worker process is consuming, for the startup log. */
export interface WorkerStartupPlan {
  queues: string[];
  scanWorkerEnabled: boolean;
  scanConcurrency: number | null;
}

/**
 * What this process will actually consume.
 *
 * Named and logged because the failure mode being fixed here was silent: a
 * queue with no consumer looks exactly like a queue with nothing in it, and
 * nothing in the startup output said which workers had been attached.
 */
export function planWorkerStartup(
  env: Record<string, string | undefined> = process.env
): WorkerStartupPlan {
  const scanWorkerEnabled = shouldStartScanWorker(env);

  return {
    queues: [
      'github-webhooks',
      'outbound-webhooks',
      ...(scanWorkerEnabled ? ['vulnerability-scans'] : []),
    ],
    scanWorkerEnabled,
    scanConcurrency: scanWorkerEnabled ? resolveScanWorkerConcurrency(env) : null,
  };
}

/** One line summarising the plan, for the startup log. */
export function describeWorkerStartup(plan: WorkerStartupPlan): string {
  const scans = plan.scanWorkerEnabled
    ? `scan worker on (concurrency=${plan.scanConcurrency})`
    : `scan worker off (${SCAN_WORKER_ENABLED_VAR})`;

  return `Consuming ${plan.queues.join(', ')} — ${scans}`;
}
