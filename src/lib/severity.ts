/**
 * The single source of truth for severity in SecureFlow.
 *
 * Before this module existed there were four separate, mutually inconsistent
 * implementations of "what is a valid severity":
 *
 *   - `armor/scanner.ts`      uppercased, checked a local array, fell back to MEDIUM
 *   - `armor/iq.ts`           compared raw strings with `===`, no normalization
 *   - `queue/worker.ts`       called `.toUpperCase()` on a possibly-null value
 *   - `severity-theme.ts`     cast and echoed the raw string back on a miss
 *
 * The gap between them was exploitable rather than merely untidy. A finding
 * carrying `severity: "critical"` failed the `=== 'CRITICAL'` test in the policy
 * engine, so the pull request was decided `PASS`; it then missed the risk-weight
 * lookup, so it contributed `0` to the stored risk score. A critical finding
 * merged clean. Separately, a `null` severity reaching `f.severity.toUpperCase()`
 * threw a `TypeError` *after* the pending PR comment had been posted, which sent
 * the job to the DLQ and left a permanent "⏳ Evaluating..." comment behind.
 *
 * Everything here is pure, total, and free of server-only imports, so it is safe
 * to import from client components (`severity-theme.ts` does) as well as from the
 * worker.
 */

/**
 * The canonical severity levels, ordered from most to least severe.
 *
 * The order is load-bearing: `severityRank` derives from the index, so inserting
 * a level in the wrong place silently changes every threshold comparison in the
 * codebase. Append-only changes are safe; reordering is not.
 */
export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

/** Membership set, built once, for the O(1) `isSeverity` check. */
const CANONICAL = new Set<string>(SEVERITY_ORDER);

/**
 * Spellings that are not canonical but unambiguously mean one of the canonical
 * levels.
 *
 * These are not hypothetical. Findings arrive from an LLM that is asked for a
 * severity but is under no obligation to produce one of five exact strings, and
 * from database rows written by earlier revisions of the scanner. `sev1`/`p1`
 * show up in imported third-party tooling output; `error`/`warning`/`info` are
 * the standard SARIF and ESLint level names, which matter for the SARIF export
 * work tracked separately.
 *
 * Keys are matched after upper-casing and whitespace collapsing, so only one
 * casing of each alias needs to be listed.
 */
const SEVERITY_ALIASES: Readonly<Record<string, Severity>> = {
  // Abbreviations
  CRIT: 'CRITICAL',
  CRITICALS: 'CRITICAL',
  SEVERE: 'CRITICAL',
  BLOCKER: 'CRITICAL',
  FATAL: 'CRITICAL',

  // Priority scales (Jira / PagerDuty / most bug trackers)
  SEV0: 'CRITICAL',
  SEV1: 'CRITICAL',
  P0: 'CRITICAL',
  P1: 'CRITICAL',
  SEV2: 'HIGH',
  P2: 'HIGH',
  SEV3: 'MEDIUM',
  P3: 'MEDIUM',
  SEV4: 'LOW',
  P4: 'LOW',

  // SARIF / linter level names
  ERROR: 'HIGH',
  WARNING: 'MEDIUM',
  WARN: 'MEDIUM',
  NOTE: 'LOW',
  INFO: 'LOW',
  INFORMATIONAL: 'LOW',
  NOTICE: 'LOW',

  // Prose the model reaches for when it ignores the enum
  MODERATE: 'MEDIUM',
  MINOR: 'LOW',
  MAJOR: 'HIGH',
  TRIVIAL: 'LOW',
  NEGLIGIBLE: 'LOW',

  // Explicit "nothing found"
  CLEAN: 'NONE',
  PASS: 'NONE',
  OK: 'NONE',
  UNKNOWN: 'NONE',
};

/**
 * Risk-score contribution per severity.
 *
 * These are the weights the worker has always used; they live here now so the
 * PR-blocking decision, the stored `ScanResult.riskScore` and any future
 * reporting all read the same numbers instead of three inline object literals
 * that can drift apart.
 */
export const SEVERITY_RISK_WEIGHT: Readonly<Record<Severity, number>> = {
  CRITICAL: 10,
  HIGH: 5,
  MEDIUM: 3,
  LOW: 1,
  NONE: 0,
};

/**
 * Emoji-prefixed label used in GitHub pull request comments.
 *
 * The worker previously open-coded this as a nested ternary that only special
 * cased CRITICAL and HIGH, so `LOW` and `NONE` findings were both rendered as
 * "🟡 MEDIUM" — the comment actively misreported the severity of the least
 * severe findings.
 */
export const SEVERITY_BADGE: Readonly<Record<Severity, string>> = {
  CRITICAL: '🔴 CRITICAL',
  HIGH: '🟠 HIGH',
  MEDIUM: '🟡 MEDIUM',
  LOW: '🔵 LOW',
  NONE: '⚪ NONE',
};

/** Counts keyed by canonical severity. Every key is always present. */
export type SeverityCountMap = Record<Severity, number>;

/** Narrowing predicate for a value that is already canonical. */
export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && CANONICAL.has(value);
}

/**
 * Reduce arbitrary input to the form the alias table is keyed on.
 *
 * Internal whitespace is collapsed and separators are stripped so `"sev 1"`,
 * `"SEV-1"` and `"sev_1"` all reach the same lookup key. Returns an empty string
 * for any non-string input, which callers treat as "no severity given".
 */
function canonicalizeKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Parse `value` into a canonical severity, or `null` when it cannot be
 * interpreted.
 *
 * Total: never throws, for any input including `null`, `undefined`, numbers,
 * objects and symbols. Use this when "I could not tell" is a meaningful answer;
 * use `normalizeSeverity` when you need a value regardless.
 */
export function parseSeverity(value: unknown): Severity | null {
  const key = canonicalizeKey(value);
  if (!key) return null;

  if (CANONICAL.has(key)) return key as Severity;

  const aliased = SEVERITY_ALIASES[key];
  return aliased ?? null;
}

/**
 * Parse `value`, falling back to `fallback` when it is uninterpretable.
 *
 * The fallback defaults to `MEDIUM` rather than `NONE` deliberately. An
 * unrecognised severity means the scanner told us *something* was wrong but did
 * not say how badly; treating that as "nothing found" would drop a real finding
 * out of enforcement entirely. MEDIUM keeps it visible and matches the pre-existing
 * behaviour in `scanner.ts`.
 */
export function normalizeSeverity(value: unknown, fallback: Severity = 'MEDIUM'): Severity {
  return parseSeverity(value) ?? fallback;
}

/**
 * Position in `SEVERITY_ORDER`. Lower is more severe.
 *
 * Unparseable input ranks last (least severe) so a corrupt value can never sort
 * itself to the top of a findings list.
 */
export function severityRank(value: unknown): number {
  const severity = parseSeverity(value);
  return severity === null ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(severity);
}

/**
 * Comparator ordering most severe first, suitable for `Array.prototype.sort`.
 */
export function compareSeverity(a: unknown, b: unknown): number {
  return severityRank(a) - severityRank(b);
}

/**
 * True when `value` is at least as severe as `threshold`.
 *
 * Replaces the open-coded `['CRITICAL', 'HIGH'].includes(...)` membership tests
 * that had to be edited by hand every time a threshold moved.
 */
export function isAtLeast(value: unknown, threshold: Severity): boolean {
  const severity = parseSeverity(value);
  if (severity === null) return false;
  return SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(threshold);
}

/** Risk-score contribution of a single severity. Unparseable input scores 0. */
export function riskWeight(value: unknown): number {
  const severity = parseSeverity(value);
  return severity === null ? 0 : SEVERITY_RISK_WEIGHT[severity];
}

/** Pull request comment badge for a severity. Unparseable input renders as NONE. */
export function severityBadge(value: unknown): string {
  return SEVERITY_BADGE[normalizeSeverity(value, 'NONE')];
}

/**
 * The most severe entry in `values`, or `null` for an empty/uninterpretable list.
 */
export function maxSeverity(values: readonly unknown[]): Severity | null {
  let best: Severity | null = null;

  for (const value of values) {
    const severity = parseSeverity(value);
    if (severity === null) continue;
    if (best === null || SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(best)) {
      best = severity;
    }
  }

  return best;
}

/** A zeroed count map. Fresh object each call — callers mutate the result. */
export function emptySeverityCounts(): SeverityCountMap {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
}

/**
 * Tally `items` by severity.
 *
 * `getSeverity` defaults to reading a `severity` property, which covers both
 * `ScanFinding` and the Prisma `Finding` row. Items whose severity cannot be
 * parsed are skipped rather than bucketed into a made-up level.
 */
export function countBySeverity<T>(
  items: readonly T[],
  getSeverity: (item: T) => unknown = (item) => (item as { severity?: unknown })?.severity
): SeverityCountMap {
  const counts = emptySeverityCounts();

  for (const item of items) {
    const severity = parseSeverity(getSeverity(item));
    if (severity !== null) counts[severity] += 1;
  }

  return counts;
}

/**
 * Total risk score for a collection of findings.
 *
 * This is the calculation the worker stores as `ScanResult.riskScore`. Keeping it
 * here means the weights and the null-handling are exercised by this module's
 * tests rather than only reachable through a full webhook job.
 */
export function totalRiskScore<T>(
  items: readonly T[],
  getSeverity: (item: T) => unknown = (item) => (item as { severity?: unknown })?.severity
): number {
  return items.reduce((total, item) => total + riskWeight(getSeverity(item)), 0);
}
