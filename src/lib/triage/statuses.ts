/**
 * The triage status vocabulary, in one place (#689).
 *
 * `FindingTriage.status` drives four different decisions, and each of the four
 * call sites wrote the list out by hand:
 *
 *   src/lib/triage/queries.ts     SUPPRESSED_STATUSES      ["FALSE_POSITIVE", "IGNORED"]
 *   src/lib/findings/query.ts     DISMISSED_STATUSES       ['FALSE_POSITIVE', 'IGNORED']
 *   src/app/leaderboard/aggregate.ts  SUPPRESSED_TRIAGE_STATUSES  ["FALSE_POSITIVE", "IGNORED"]
 *   src/lib/actions/triage.ts     TRIAGE_STATUSES          ["OPEN", "RESOLVED", …]
 *
 * They agree today. The comment on `DISMISSED_STATUSES` says a test asserts
 * they agree, which is a workaround for their not being one thing — and the
 * comment on the leaderboard copy explains it was duplicated to avoid pulling
 * the triage module's Prisma calls into a cached path. That reason is real, and
 * it is the reason this module exists and holds nothing but the lists.
 *
 * Pure and free of server-only imports, like `severity.ts` and
 * `finding-taxonomy.ts`, so a client component or a cached server path can
 * import it without dragging a database client along.
 */

/**
 * Every state a finding can be triaged into.
 *
 * `OPEN` is the implicit default: a finding with no `FindingTriage` row at all
 * is open, which is why the status filter in `findings/query.ts` resolves it as
 * "not in the triaged set" rather than as a value to match.
 */
export const TRIAGE_STATUSES = ['OPEN', 'RESOLVED', 'FALSE_POSITIVE', 'IGNORED'] as const;

export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

/**
 * Statuses that take a finding out of enforcement.
 *
 * These are excluded from the dashboard tiles, from the risk metrics, from the
 * leaderboard's vulnerability counts, and from the worker's PR-blocking
 * decision. `RESOLVED` is deliberately not one of them: a resolved finding was
 * real and was fixed, so it still counts toward the author's history.
 */
export const SUPPRESSED_STATUSES = ['FALSE_POSITIVE', 'IGNORED'] as const;

export type SuppressedStatus = (typeof SUPPRESSED_STATUSES)[number];

const SUPPRESSED = new Set<string>(SUPPRESSED_STATUSES);
const ALL = new Set<string>(TRIAGE_STATUSES);

/** True when `status` takes a finding out of enforcement. */
export function isSuppressedStatus(status: unknown): status is SuppressedStatus {
  return typeof status === 'string' && SUPPRESSED.has(status);
}

/** Narrowing predicate for a recognised triage status. */
export function isTriageStatus(status: unknown): status is TriageStatus {
  return typeof status === 'string' && ALL.has(status);
}
