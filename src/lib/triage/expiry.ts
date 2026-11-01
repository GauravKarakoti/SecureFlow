import { SUPPRESSED_STATUSES, isSuppressedStatus } from "./statuses";

export interface TriageSuppressionCandidate {
  status: string;
  expiresAt?: Date | string | null;
}

/**
 * Pure predicate determining whether a triage suppression is currently active.
 *
 * A finding is actively suppressed if:
 * 1. Its status is a dismissal status (FALSE_POSITIVE or IGNORED), and
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
 * status IN ('FALSE_POSITIVE', 'IGNORED') AND (expiresAt IS NULL OR expiresAt > now)
 */
export function activeSuppressionWhere(now: Date) {
  return {
    status: { in: [...SUPPRESSED_STATUSES] },
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: now } },
    ],
  };
}

/**
 * Maximum allowed expiry window: 365 days from now.
 */
export const MAX_EXPIRY_DAYS = 365;

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

