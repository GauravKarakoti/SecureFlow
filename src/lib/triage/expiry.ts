import { SUPPRESSED_STATUSES, isSuppressedStatus } from "./statuses";
import prisma from "@/lib/prisma";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

export interface TriageSuppressionCandidate {
  status: string;
  expiresAt?: Date | string | null;
}

/**
 * Pure predicate determining whether a triage suppression is currently active.
 *
 * A finding is actively suppressed if:
 * 1. Its status is a dismissal status (FALSE_POSITIVE, IGNORED, or DISMISSED), and
 * 2. It has no expiry (expiresAt is null/undefined) OR its expiresAt date is strictly after `now`.
 *
 * Boundary condition: expiresAt <= now counts as EXPIRED (not active).
 * The clock `now` is strictly injected, never read inside this helper.
 */
export function isSuppressionActive(
  candidate: TriageSuppressionCandidate | null | undefined,
  now: Date,
): boolean {
  if (!candidate || !isSuppressedStatus(candidate.status)) {
    return false;
  }

  if (candidate.expiresAt === null || candidate.expiresAt === undefined) {
    return true;
  }

  const expiryTime =
    candidate.expiresAt instanceof Date
      ? candidate.expiresAt.getTime()
      : new Date(candidate.expiresAt).getTime();

  if (Number.isNaN(expiryTime)) {
    // If unparseable date, fail-safe to not suppressed so risk isn't hidden
    return false;
  }

  return expiryTime > now.getTime();
}

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

/**
 * Maximum allowed expiry window: 365 days from now.
 */
export const MAX_EXPIRY_DAYS = 365;

/**
 * Calculates the end of the current quarter (or next quarter if current has passed).
 * End dates: Q1: Mar 31, Q2: Jun 30, Q3: Sep 30, Q4: Dec 31.
 */
export function getEndOfQuarter(from: Date = new Date()): Date {
  const year = from.getFullYear();
  const currentQuarter = Math.floor(from.getMonth() / 3); // 0, 1, 2, 3
  const endMonth = (currentQuarter + 1) * 3; // 3, 6, 9, 12
  // Day 0 of next month in local time gives the last day of the target month
  const endOfQuarter = new Date(year, endMonth, 0, 23, 59, 59, 999);
  if (endOfQuarter.getTime() <= from.getTime()) {
    return new Date(year, endMonth + 3, 0, 23, 59, 59, 999);
  }
  return endOfQuarter;
}

/**
 * Computes an expiry Date object from a selection identifier.
 * Supported selections:
 *  - "none" / "" / null -> null (permanent)
 *  - "30" -> 30 days from now
 *  - "90" -> 90 days from now
 *  - "end_of_quarter" / "quarter" -> end of current quarter
 *  - "custom" -> parses customDateInput
 *  - numeric string (e.g. "7") -> N days from now
 */
export function computeExpiryDate(
  selection: string | null | undefined,
  customDateInput?: string | Date | null,
  now: Date = new Date(),
): Date | null {
  if (!selection || selection === "none") return null;

  if (selection === "30") {
    return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  }
  if (selection === "90") {
    return new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  }
  if (selection === "end_of_quarter" || selection === "quarter") {
    return getEndOfQuarter(now);
  }
  if (selection === "custom") {
    if (!customDateInput) return null;
    const date = customDateInput instanceof Date ? customDateInput : new Date(customDateInput);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  const numDays = parseInt(selection, 10);
  if (!Number.isNaN(numDays) && numDays > 0) {
    return new Date(now.getTime() + numDays * 24 * 60 * 60 * 1000);
  }

  return null;
}

/**
 * Checks whether an expiry date falls within `windowDays` from `now` (default 14 days).
 * Boundary: must be strictly in the future relative to `now`, and <= now + windowDays.
 */
export function isExpiringSoon(
  expiresAt: Date | string | null | undefined,
  windowDays: number = 14,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const expiryTime =
    expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (Number.isNaN(expiryTime)) return false;

  const nowTime = now.getTime();
  const cutoffTime = nowTime + windowDays * 24 * 60 * 60 * 1000;
  return expiryTime > nowTime && expiryTime <= cutoffTime;
}

/**
 * Validates an optional expiresAt input against current clock `now`.
 * Returns { ok: true, expiresAt: Date | null } or { ok: false, error: string }.
 */
export function validateExpiryDate(
  expiresAtInput: Date | string | null | undefined,
  now: Date,
): { ok: true; expiresAt: Date | null } | { ok: false; error: string } {
  if (expiresAtInput === null || expiresAtInput === undefined || expiresAtInput === "") {
    return { ok: true, expiresAt: null };
  }

  const date = expiresAtInput instanceof Date ? expiresAtInput : new Date(expiresAtInput);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "Invalid expiry date format" };
  }

  if (date.getTime() <= now.getTime()) {
    return { ok: false, error: "Expiry date must be in the future" };
  }

  const maxDate = new Date(now.getTime() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  if (date.getTime() > maxDate.getTime()) {
    return { ok: false, error: "Expiry date cannot be more than 365 days in the future" };
  }

  return { ok: true, expiresAt: date };
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
