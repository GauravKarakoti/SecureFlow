import prisma from "@/lib/prisma";
import { createLogger } from "@/lib/logger";
import { SUPPRESSED_STATUSES, isSuppressedStatus, type TriageStatus } from "./statuses";
import { isSuppressionActive, activeSuppressionWhere } from "./expiry";

/**
 * Triage lookups for the dashboard (#689, #1503).
 */

const log = createLogger({ context: { component: "triage-queries" } });

export { SUPPRESSED_STATUSES };
export type { TriageStatus };

export const MAX_SUPPRESSED_FINGERPRINTS = 5_000;
export const MAX_TRIAGE_ROWS = 5_000;

export interface TriageEntry {
  status: string;
  note: string | null;
  expiresAt?: Date | null;
}

export interface UserTriage {
  /** Fingerprints the user has dismissed (FALSE_POSITIVE / IGNORED) and not yet expired. */
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
 * Just the fingerprints a user has dismissed and that are still actively suppressed.
 */
export async function getSuppressedFingerprints(userId: string): Promise<SuppressedFingerprints> {
  const rows = await prisma.findingTriage.findMany({
    where: {
      repository: { userId },
      ...activeSuppressionWhere(new Date()),
    },
    select: { fingerprint: true },
    take: MAX_SUPPRESSED_FINGERPRINTS + 1,
  });

  const truncated = rows.length > MAX_SUPPRESSED_FINGERPRINTS;

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
 * Every triage row for the repositories a user owns, plus the active dismissed set.
 */
export async function getUserTriage(userId: string): Promise<UserTriage> {
  const rows = await prisma.findingTriage.findMany({
    where: { repository: { userId } },
    select: { repositoryId: true, fingerprint: true, status: true, note: true, expiresAt: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_TRIAGE_ROWS + 1,
  });

  const truncated = rows.length > MAX_TRIAGE_ROWS;
  const kept = truncated ? rows.slice(0, MAX_TRIAGE_ROWS) : rows;

  const suppressed = new Set<string>();
  const byKey = new Map<string, TriageEntry>();
  const now = new Date();

  for (const row of kept) {
    byKey.set(triageKey(row.repositoryId, row.fingerprint), {
      status: row.status,
      note: row.note,
      expiresAt: row.expiresAt,
    });

    if (isSuppressionActive({ status: row.status, expiresAt: row.expiresAt }, now)) {
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
