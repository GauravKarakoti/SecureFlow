import prisma from "@/lib/prisma";

// Statuses that suppress a finding from the dashboard tiles and risk metrics
// (and, in the worker, from the PR-blocking decision).
export const SUPPRESSED_STATUSES = ["FALSE_POSITIVE", "IGNORED"] as const;

export interface TriageEntry {
  status: string;
  note: string | null;
}

export interface UserTriage {
  /** Fingerprints the user has dismissed (FALSE_POSITIVE / IGNORED). */
  suppressedFingerprints: string[];
  /** `${repositoryId}:${fingerprint}` -> current triage state, for the UI. */
  byKey: Map<string, TriageEntry>;
}

export function triageKey(repositoryId: string, fingerprint: string): string {
  return `${repositoryId}:${fingerprint}`;
}

/**
 * Load all triage rows for the repositories a user owns. Returns the set of
 * dismissed fingerprints (to exclude from tiles / risk) plus a lookup keyed by
 * repository + fingerprint so finding rows can render their current status.
 *
 * Triage keys off the stable fingerprint rather than Finding.id, which is why
 * this is a separate lookup instead of a relational include on Finding.
 */
export async function getUserTriage(userId: string): Promise<UserTriage> {
  const rows = await prisma.findingTriage.findMany({
    where: { repository: { userId } },
    select: { repositoryId: true, fingerprint: true, status: true, note: true },
  });

  const suppressedFingerprints: string[] = [];
  const byKey = new Map<string, TriageEntry>();

  for (const row of rows) {
    byKey.set(triageKey(row.repositoryId, row.fingerprint), {
      status: row.status,
      note: row.note,
    });
    if ((SUPPRESSED_STATUSES as readonly string[]).includes(row.status)) {
      suppressedFingerprints.push(row.fingerprint);
    }
  }

  return { suppressedFingerprints, byKey };
}
