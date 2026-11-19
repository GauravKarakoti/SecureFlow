/**
 * Finding Age & Overdue Helpers
 *
 * Computes how old a finding is (from the first time its fingerprint was seen,
 * i.e. `createdAt`) and whether it has exceeded the configurable target age for
 * its severity.
 *
 * Target ages are read from environment variables with safe defaults:
 *
 *   FINDING_AGE_TARGET_CRITICAL=3   (days)
 *   FINDING_AGE_TARGET_HIGH=14      (days)
 *   FINDING_AGE_TARGET_MEDIUM=30    (days)
 *   FINDING_AGE_TARGET_LOW=90       (days)
 *   FINDING_AGE_TARGET_INFO=        (not set → no target / never overdue)
 *
 * Every pure function here is unit-tested in age.test.ts without a database.
 */

/** Sensible defaults (in days). INFO/undefined means "no target". */
export const DEFAULT_AGE_TARGETS: Record<string, number | null> = {
  CRITICAL: 3,
  HIGH: 14,
  MEDIUM: 30,
  LOW: 90,
  INFO: null,
};

/**
 * Parse and validate a single age-target env-var value.
 *
 * Returns `null` when the variable is absent or empty (no target).
 * Throws when the value is present but not a positive integer.
 */
export function parseAgeTargetEnv(raw: string | undefined, varName: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${varName} must be a positive integer (days), got: "${raw.trim()}"`);
  }
  return n;
}

/**
 * Build the effective target-age map from `process.env`.
 *
 * Merges the env-variable overrides on top of the defaults. A severity whose
 * env var is set to an empty string inherits its default (not suppressed).
 * To suppress a target entirely set it to a value that the validator will not
 * accept — but the cleaner idiom is simply not to set it.
 *
 * Call this once at module load in production, or inject a custom map in tests.
 */
export function buildAgeTargets(
  env: Record<string, string | undefined> = process.env,
): Record<string, number | null> {
  const mapping: Array<{ severity: string; varName: string }> = [
    { severity: "CRITICAL", varName: "FINDING_AGE_TARGET_CRITICAL" },
    { severity: "HIGH", varName: "FINDING_AGE_TARGET_HIGH" },
    { severity: "MEDIUM", varName: "FINDING_AGE_TARGET_MEDIUM" },
    { severity: "LOW", varName: "FINDING_AGE_TARGET_LOW" },
    { severity: "INFO", varName: "FINDING_AGE_TARGET_INFO" },
  ];

  const targets: Record<string, number | null> = { ...DEFAULT_AGE_TARGETS };

  for (const { severity, varName } of mapping) {
    const raw = env[varName];
    if (raw === undefined || raw.trim() === "") continue; // keep default
    const parsed = parseAgeTargetEnv(raw, varName);
    targets[severity] = parsed;
  }

  return targets;
}

/** Singleton — resolved once at startup, can be overridden in tests. */
export const AGE_TARGETS: Record<string, number | null> = buildAgeTargets();

// ─── Core logic ──────────────────────────────────────────────────────────────

/**
 * Compute the age of a finding in whole days.
 *
 * Returns `null` when `createdAt` is absent (the row predates fingerprinting
 * or was inserted without a date).
 */
export function findingAgeDays(
  createdAt: Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!createdAt) return null;
  const ms = now.getTime() - createdAt.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Decide whether a finding is overdue.
 *
 * Rules:
 * - Dismissed findings are **never** overdue (caller is responsible for
 *   passing the correct status).
 * - A finding with no `createdAt` is **not** overdue (no information → no alarm).
 * - A severity with no target (`null`) is **not** overdue.
 * - A finding is overdue when its age strictly exceeds its target (age > target).
 */
export function isFindingOverdue(
  severity: string,
  createdAt: Date | null | undefined,
  triageStatus: string,
  targets: Record<string, number | null> = AGE_TARGETS,
  now: Date = new Date(),
): boolean {
  if (triageStatus === "DISMISSED") return false;
  const ageDays = findingAgeDays(createdAt, now);
  if (ageDays === null) return false;
  const target = targets[severity] ?? null;
  if (target === null) return false;
  return ageDays > target;
}

/**
 * Human-readable age string, e.g. "2d", "1d", "0d".
 * Returns "—" when `createdAt` is absent.
 */
export function formatAgeDays(createdAt: Date | null | undefined, now: Date = new Date()): string {
  const days = findingAgeDays(createdAt, now);
  if (days === null) return "—";
  return `${days}d`;
}

/**
 * Count overdue open findings in a list.
 *
 * Dismissed findings are skipped (by contract from `isFindingOverdue`).
 */
export function countOverdue(
  findings: Array<{
    severity: string;
    createdAt: Date | null | undefined;
    triageStatus: string;
  }>,
  targets: Record<string, number | null> = AGE_TARGETS,
  now: Date = new Date(),
): number {
  return findings.filter((f) =>
    isFindingOverdue(f.severity, f.createdAt, f.triageStatus, targets, now),
  ).length;
}
