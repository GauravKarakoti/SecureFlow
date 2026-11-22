import { SUPPRESSED_STATUSES } from "./statuses";
import prisma from "@/lib/prisma";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

export {
  MAX_EXPIRY_DAYS,
  computeExpiryDate,
  getEndOfQuarter,
  isExpiringSoon,
  isSuppressionActive,
  validateExpiryDate,
  type TriageSuppressionCandidate,
} from "./expiry";

/**
 * Returns a Prisma `where` fragment representing finding triage records
 * that are currently suppressed and have not lapsed past `now`.
 *
 * Equivalent to:
 * status IN ('FALSE_POSITIVE', 'IGNORED', 'DISMISSED') AND (expiresAt IS NULL OR expiresAt > now)
 */
export function activeSuppressionWhere(now: Date) {
  return {
    status: { in: [...SUPPRESSED_STATUSES] },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export interface AutoReopenResult {
  reopenedFingerprints: string[];
  reopenedCount: number;
}

export interface FindingLike {
  fingerprint?: string;
  explanation?: string;
  description?: string;
  note?: string;
  expiryNote?: string;
}

/**
 * Scans for expired dismissals matching findings in `findings`.
 * For any finding whose triage record has expired (`status in SUPPRESSED_STATUSES` and `expiresAt <= now`):
 *  1. Attaches note "previous dismissal expired on DATE" to the finding.
 *  2. Updates FindingTriage record status to "OPEN" with the note.
 *  3. Records automatic reopening in the audit log.
 */
export async function handleExpiredDismissals<T extends FindingLike>(
  repositoryId: string,
  findings: T[],
  now: Date = new Date(),
  options: {
    prismaClient?: any;
    repoFullName?: string;
    userId?: string;
  } = {},
): Promise<AutoReopenResult> {
  const db = options.prismaClient ?? prisma;
  if (!repositoryId || !findings || findings.length === 0) {
    return { reopenedFingerprints: [], reopenedCount: 0 };
  }

  const findingFingerprints = new Set(
    findings.map((f) => f.fingerprint).filter((fp): fp is string => Boolean(fp)),
  );
  if (findingFingerprints.size === 0) {
    return { reopenedFingerprints: [], reopenedCount: 0 };
  }

  const expiredTriages = await db.findingTriage.findMany({
    where: {
      repositoryId,
      status: { in: [...SUPPRESSED_STATUSES] },
      expiresAt: { lte: now },
      fingerprint: { in: [...findingFingerprints] },
    },
  });

  if (!expiredTriages || expiredTriages.length === 0) {
    return { reopenedFingerprints: [], reopenedCount: 0 };
  }

  const expiredMap = new Map<string, any>(expiredTriages.map((t: any) => [t.fingerprint, t]));

  const reopenedFingerprints: string[] = [];

  for (const finding of findings) {
    if (!finding.fingerprint || !expiredMap.has(finding.fingerprint)) continue;

    const triage = expiredMap.get(finding.fingerprint);
    const dateStr = triage.expiresAt
      ? triage.expiresAt instanceof Date
        ? triage.expiresAt.toISOString().slice(0, 10)
        : new Date(triage.expiresAt).toISOString().slice(0, 10)
      : "";
    const noteText = `previous dismissal expired on ${dateStr}`;

    finding.expiryNote = noteText;
    finding.note = noteText;

    if (finding.explanation && !finding.explanation.includes("previous dismissal expired on")) {
      finding.explanation = `${finding.explanation}\n\nNote: ${noteText}`;
    }
    if (finding.description && !finding.description.includes("previous dismissal expired on")) {
      finding.description = `${finding.description} (${noteText})`;
    }

    reopenedFingerprints.push(finding.fingerprint);

    try {
      await db.findingTriage.update({
        where: {
          repositoryId_fingerprint: {
            repositoryId,
            fingerprint: finding.fingerprint,
          },
        },
        data: {
          status: "OPEN",
          note: noteText,
          dismissalReason: null,
          dismissedAt: null,
          dismissedById: null,
          expiresAt: null,
        },
      });

      await db.auditLog.create({
        data: sanitizeAuditLogInput({
          userId: options.userId ?? "system",
          action: "Finding Auto-Reopened",
          resource: `${options.repoFullName ?? repositoryId}:${finding.fingerprint.slice(0, 12)}`,
          decision: "OPEN",
          metadata: {
            repositoryId,
            fingerprint: finding.fingerprint,
            reason: "Dismissal expired",
            expiredAt:
              triage.expiresAt instanceof Date ? triage.expiresAt.toISOString() : triage.expiresAt,
            note: noteText,
            autoReopened: true,
          },
        }),
      });
    } catch (err) {
      console.error(
        `[handleExpiredDismissals] Failed to record auto-reopening for fingerprint ${finding.fingerprint}:`,
        err,
      );
    }
  }

  return {
    reopenedFingerprints,
    reopenedCount: reopenedFingerprints.length,
  };
}
