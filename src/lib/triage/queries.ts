import prisma from "@/lib/prisma";
import { createLogger } from "@/lib/logger";
import {
  SUPPRESSED_STATUSES,
  isSuppressedStatus,
  type TriageStatus,
} from "./statuses";

/**
 * Triage lookups for the dashboard (#689).
 *
 * `getUserTriage` used to read **every** triage row a user owns — no `where` on
 * the status, no `take` — on every render of `/dashboard` and
 * `/dashboard/findings`, and hand the resulting fingerprints to Prisma as a
 * `notIn` list. Three separate things grew without bound:
 *
 *  1. **Rows read.** `FindingTriage` accumulates. A row is written per triage
 *     click and the retention purge does not remove them, so the result set
 *     only ever grows.
 *  2. **Query parameters.** Each fingerprint is a 64-character SHA-256 hex
 *     string. `/dashboard` spreads the resulting `notIn` into six separate
 *     `finding.count()` calls, so a user with 5,000 dismissals sends roughly
 *     320 KB of literals six times per page load. Postgres plans a large
 *     `NOT IN (…)` against the literal list per row, and PgBouncer in
 *     transaction mode has to buffer the whole statement.
 *  3. **Page loads.** Every one of them paid the above.
 *
 * The fixes are the boring ones. The suppressed set is now filtered in the
 * database rather than in a loop over every row; both entry points are capped,
 * and a cap that is hit is reported rather than silently applied; and the
 * dashboard, which only ever wanted the suppressed set, no longer builds the
 * full lookup with every triage note in it.
 *
 * The status vocabulary moved to `./statuses`, which is pure — four call sites
 * were maintaining their own copy of the same two strings.
 */

const log = createLogger({ context: { component: "triage-queries" } });

export { SUPPRESSED_STATUSES };
export type { TriageStatus };

/**
 * Ceiling on fingerprints expanded into a `notIn`.
 *
 * Past this, the exclusion list costs more than the rows it excludes and the
 * right answer is a join rather than a literal list. The cap is high enough
 * that no ordinary account reaches it, and the shape follows
 * `USERS_FETCH_ALL_LIMIT` in `src/lib/actions/admin.ts`: bound the work, and
 * tell the caller when the bound was reached instead of presenting a prefix as
 * the whole set.
 */
export const MAX_SUPPRESSED_FINGERPRINTS = 5_000;

/** Ceiling on rows loaded for the full per-repository lookup. */
export const MAX_TRIAGE_ROWS = 5_000;

export interface TriageEntry {
  status: string;
  note: string | null;
}

export interface UserTriage {
  /** Fingerprints the user has dismissed (FALSE_POSITIVE / IGNORED), de-duplicated. */
  suppressedFingerprints: string[];
  /** `${repositoryId}:${fingerprint}` -> current triage state, for the UI. */
  byKey: Map<string, TriageEntry>;
  /** True when a cap stopped the read before the table was drained. */
  truncated: boolean;
}

export function triageKey(repositoryId: string, fingerprint: string): string {
  return `${repositoryId}:${fingerprint}`;
}

export interface SuppressedFingerprints {
  /** De-duplicated, ready to spread into a `notIn`. */
  fingerprints: string[];
  /** Membership test, for callers filtering in memory rather than in SQL. */
  has: (fingerprint: string) => boolean;
  /** True when `MAX_SUPPRESSED_FINGERPRINTS` stopped the read. */
  truncated: boolean;
}

/**
 * Just the fingerprints a user has dismissed.
 *
 * The filter is a `where` clause rather than a loop over every row, so the
 * database returns the rows that matter instead of all of them — and `select`
 * asks for one column instead of four, which keeps the unbounded free-text
 * `note` out of a result the caller never reads.
 *
 * This is what `/dashboard` needs. It was calling `getUserTriage` and
 * discarding `byKey`, paying for every triage note on the way.
 */
export async function getSuppressedFingerprints(
  userId: string
): Promise<SuppressedFingerprints> {
  // One over the cap, so hitting it is distinguishable from landing exactly on it.
  const rows = await prisma.findingTriage.findMany({
    where: {
      repository: { userId },
      status: { in: [...SUPPRESSED_STATUSES] },
    },
    select: { fingerprint: true },
    take: MAX_SUPPRESSED_FINGERPRINTS + 1,
  });

  const truncated = rows.length > MAX_SUPPRESSED_FINGERPRINTS;

  // A Set, not an array: `byKey` is keyed by repository *and* fingerprint, so
  // the same fingerprint can legitimately appear on several rows, and every
  // consumer of this list wants set semantics.
  const unique = new Set<string>();
  for (const row of rows.slice(0, MAX_SUPPRESSED_FINGERPRINTS)) {
    unique.add(row.fingerprint);
  }

  if (truncated) {
    log.warn("Suppressed-fingerprint list truncated by the query ceiling", {
      limit: MAX_SUPPRESSED_FINGERPRINTS,
      returned: unique.size,
    });
  }

  return {
    fingerprints: [...unique],
    has: (fingerprint: string) => unique.has(fingerprint),
    truncated,
  };
}

/**
 * Every triage row for the repositories a user owns, plus the dismissed set.
 *
 * Returns the lookup keyed by repository + fingerprint so a findings row can
 * render its current status and note, which is why this reads more than
 * {@link getSuppressedFingerprints} does. Callers that only need the dismissed
 * set should use that instead.
 *
 * Triage keys off the stable fingerprint rather than `Finding.id`, which is why
 * this is a separate lookup instead of a relational include on `Finding`.
 */
export async function getUserTriage(userId: string): Promise<UserTriage> {
  const rows = await prisma.findingTriage.findMany({
    where: { repository: { userId } },
    select: { repositoryId: true, fingerprint: true, status: true, note: true },
    // Newest first, so a cap keeps the decisions the user made most recently
    // rather than whichever ones the database happened to return.
    orderBy: { updatedAt: "desc" },
    take: MAX_TRIAGE_ROWS + 1,
  });

  const truncated = rows.length > MAX_TRIAGE_ROWS;
  const kept = truncated ? rows.slice(0, MAX_TRIAGE_ROWS) : rows;

  const suppressed = new Set<string>();
  const byKey = new Map<string, TriageEntry>();

  for (const row of kept) {
    byKey.set(triageKey(row.repositoryId, row.fingerprint), {
      status: row.status,
      note: row.note,
    });
    // Set membership rather than a linear scan of the status list per row.
    if (isSuppressedStatus(row.status)) {
      suppressed.add(row.fingerprint);
    }
  }

  if (truncated) {
    log.warn("Triage lookup truncated by the query ceiling", {
      limit: MAX_TRIAGE_ROWS,
      returned: kept.length,
    });
  }

  return { suppressedFingerprints: [...suppressed], byKey, truncated };
}
