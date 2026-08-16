/**
 * Dependency probes behind `/api/health/ready`.
 *
 * The web app and the worker both hard-depend on Postgres and Redis, and either
 * can be down while the HTTP process is perfectly happy to accept connections:
 *
 *  - Redis down  -> every webhook delivery is accepted with `202 queued` and
 *                   then silently dropped, because `addWebhookJob` cannot reach
 *                   BullMQ.
 *  - Postgres down -> the scan pipeline fails after the pending PR comment has
 *                   already been posted.
 *
 * In both cases the platform sees a live process, keeps routing traffic to it,
 * and nobody finds out until someone notices scans have stopped. These probes
 * make that visible.
 *
 * Every check is individually timed out. A probe that can hang is worse than no
 * probe: an orchestrator waiting on a stuck readiness endpoint will not restart
 * the container, it will just wait.
 */

/** Health of a single dependency. */
export type CheckStatus = 'up' | 'degraded' | 'down' | 'skipped';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** Wall-clock duration of the probe, in milliseconds. */
  durationMs: number;
  /**
   * Short, non-sensitive explanation. Never a raw driver error: those carry
   * connection strings, hostnames and occasionally credentials, and this
   * response is reachable by anything that can reach the app.
   */
  detail?: string;
  /** Free-form, non-sensitive extras (queue depth, and so on). */
  meta?: Record<string, number | string | boolean>;
}

/** Default per-check timeout. Shorter than any sensible orchestrator's own. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/** Waiting jobs above this depth downgrade the queue check to `degraded`. */
export const QUEUE_DEPTH_DEGRADED_THRESHOLD = 1_000;

/** Sentinel used to distinguish a timeout from a probe that resolved. */
const TIMED_OUT = Symbol('timed-out');

/**
 * Run `probe` with a hard deadline.
 *
 * The timer is always cleared, including on the timeout path, so a probe that
 * eventually settles cannot keep the process alive in a short-lived runtime.
 */
export async function withTimeout<T>(
  probe: () => Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  try {
    return await Promise.race([probe(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wrap a raw probe into a `CheckResult`, applying the timeout and turning any
 * thrown error into a `down` result rather than letting it escape.
 *
 * This is the only place that decides what a caller is told about a failure. The
 * error's message is deliberately discarded — see the `detail` note above.
 */
export async function runCheck(
  name: string,
  probe: () => Promise<Omit<CheckResult, 'name' | 'durationMs'>>,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
  now: () => number = Date.now
): Promise<CheckResult> {
  const startedAt = now();

  try {
    const outcome = await withTimeout(probe, timeoutMs);

    if (outcome === TIMED_OUT) {
      return {
        name,
        status: 'down',
        durationMs: now() - startedAt,
        detail: `timed out after ${timeoutMs}ms`,
      };
    }

    return { name, durationMs: now() - startedAt, ...outcome };
  } catch {
    return {
      name,
      status: 'down',
      durationMs: now() - startedAt,
      detail: 'unreachable',
    };
  }
}

/** Minimal shape this module needs from the Prisma client. */
export interface DatabaseProbe {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

/** Minimal shape this module needs from the Redis client. */
export interface RedisProbe {
  ping: () => Promise<string>;
}

/** The BullMQ job states this module asks about. */
export type QueueJobType = 'waiting' | 'active' | 'failed';

/**
 * Minimal shape this module needs from a BullMQ queue.
 *
 * The parameter is narrowed to the three states actually requested rather than
 * widened to `string`, so a real `Queue` (whose signature takes BullMQ's own
 * `JobType` union) satisfies this structurally.
 */
export interface QueueProbe {
  getJobCounts: (...types: QueueJobType[]) => Promise<Record<string, number>>;
}

/**
 * `SELECT 1` through Prisma.
 *
 * Deliberately not a real table read: this must answer "can I reach the
 * database", not "is the schema what I expect", and it must not be affected by
 * how much data happens to be in any table.
 */
export function databaseProbe(db: DatabaseProbe) {
  return async (): Promise<Omit<CheckResult, 'name' | 'durationMs'>> => {
    await db.$queryRaw`SELECT 1`;
    return { status: 'up' };
  };
}

/** `PING`, expecting the conventional `PONG`. */
export function redisProbe(client: RedisProbe) {
  return async (): Promise<Omit<CheckResult, 'name' | 'durationMs'>> => {
    const reply = await client.ping();

    if (typeof reply !== 'string' || reply.toUpperCase() !== 'PONG') {
      return { status: 'down', detail: 'unexpected ping reply' };
    }

    return { status: 'up' };
  };
}

/**
 * Queue depth.
 *
 * A deep backlog is reported as `degraded` rather than `down`: the dependency is
 * working, it is just behind. Failing readiness on a backlog would take the
 * instance out of rotation and make the backlog worse.
 */
export function queueProbe(
  queue: QueueProbe,
  threshold: number = QUEUE_DEPTH_DEGRADED_THRESHOLD
) {
  return async (): Promise<Omit<CheckResult, 'name' | 'durationMs'>> => {
    const counts = await queue.getJobCounts('waiting', 'active', 'failed');

    const waiting = Number(counts?.waiting ?? 0);
    const active = Number(counts?.active ?? 0);
    const failed = Number(counts?.failed ?? 0);

    const meta = { waiting, active, failed };

    if (waiting > threshold) {
      return { status: 'degraded', detail: 'queue backlog above threshold', meta };
    }

    return { status: 'up', meta };
  };
}

export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'error';
  checks: CheckResult[];
}

/**
 * Fold individual results into one overall verdict.
 *
 * `required` names the checks that gate readiness. The queue check is
 * intentionally not required: it reports load, and an instance that is merely
 * behind should stay in rotation.
 *
 * A `skipped` check never fails the report — it means the dependency is not
 * configured for this deployment, which is a valid state, not an outage.
 */
export function summarize(checks: CheckResult[], required: string[]): ReadinessReport {
  const requiredSet = new Set(required);

  const hasFailure = checks.some(
    (check) => requiredSet.has(check.name) && check.status === 'down'
  );
  const hasDegraded = checks.some((check) => check.status === 'degraded');

  return {
    status: hasFailure ? 'error' : hasDegraded ? 'degraded' : 'ok',
    checks,
  };
}

/** HTTP status for a readiness verdict. Only a hard failure sheds traffic. */
export function statusCodeFor(report: ReadinessReport): number {
  return report.status === 'error' ? 503 : 200;
}
