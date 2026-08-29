import prisma from "@/lib/prisma";

export interface LandingStats {
  prsCount: number;
  secretsCount: number;
  reposCount: number;
  scanAverage: number;
  /** True only when every count came from the database. See {@link getLandingStats}. */
  isLive: boolean;
}

export interface DetailedLandingMetrics extends LandingStats {
  totalScans: number;
  totalVulnerabilities: number;
  totalMisconfigs: number;
  blockedPRs: number;
  passedPRs: number;
}

export const BASELINE_FALLBACK_METRICS: LandingStats = {
  prsCount: 45208,
  secretsCount: 1842,
  reposCount: 948,
  scanAverage: 1.4,
  isLive: false,
};

/**
 * The advertised scan time, in seconds.
 *
 * Stated as a constant rather than measured, because it cannot be measured from
 * the current schema: `ScanResult` records `riskScore`, `policyDecision` and
 * `createdAt`, and nothing anywhere stores how long a scan took. It used to be
 * the bare literal `1.4` in the middle of the returned object, sitting beside
 * four genuine counts and indistinguishable from them.
 *
 * Naming it does not make it a measurement. It makes it visible that it is not
 * one, which is the honest state of affairs until a `durationMs` column exists
 * on `ScanResult` for this to average over.
 */
export const ADVERTISED_SCAN_AVERAGE_SECONDS = 1.4;

/** One count that may have failed. `null` means the query did not come back. */
type CountResult = number | null;

/** The four counts both public functions are built from. */
export interface LandingCounts {
  prs: CountResult;
  secrets: CountResult;
  repos: CountResult;
  scans: CountResult;
}

/** Run one count, logging and degrading to `null` rather than failing the batch. */
async function safeCount(label: string, run: () => Promise<number>): Promise<CountResult> {
  try {
    return await run();
  } catch (err) {
    console.error(`[LandingStats] Failed to count ${label}:`, err);
    return null;
  }
}

/**
 * Read the four base counts in one round of queries.
 *
 * Extracted so `getDetailedLandingMetrics` can reuse the result. It used to
 * call `getLandingStats` — which counts `ScanResult` — and then count
 * `ScanResult` *again* in its own batch, so every request to
 * `/api/metrics/landing` issued the same aggregate twice.
 */
export async function readLandingCounts(): Promise<LandingCounts> {
  const [prs, secrets, repos, scans] = await Promise.all([
    safeCount("PRs", () => prisma.pullRequest.count()),
    safeCount("Secrets", () => prisma.finding.count({ where: { type: "SECRET" } })),
    safeCount("Repositories", () => prisma.repository.count({ where: { isActive: true } })),
    safeCount("ScanResults", () => prisma.scanResult.count()),
  ]);

  return { prs, secrets, repos, scans };
}

/**
 * Turn the raw counts into the public shape.
 *
 * Two things this deliberately does not do any more:
 *
 *  - **It does not invent numbers for a fresh install.** There used to be a
 *    branch guarded on all three counts being exactly `0` whose comment said it
 *    "returns baseline values for display". It did not: `0 ?? fallback` is `0`,
 *    so every override in it evaluated to zero. What it *did* carry over from
 *    the baseline was `scanAverage`, and it set `isLive: true` next to it. An
 *    empty install genuinely has no pull requests, and saying so is correct.
 *
 *  - **It does not call a partly-fabricated response live.** `isLive` was
 *    computed from three of the four counts, so a failed `ScanResult` query left
 *    it `true`. It now requires all four, which is what the flag has always
 *    claimed to mean.
 *
 * The per-field baseline substitution on failure is kept: a marketing page that
 * renders `0` because Postgres blinked is worse than one showing a stated
 * figure. But it is now always accompanied by `isLive: false`, which is the
 * caller's signal that at least one number on the page did not come from the
 * database.
 */
export function toLandingStats(counts: LandingCounts): LandingStats {
  return {
    prsCount: counts.prs ?? BASELINE_FALLBACK_METRICS.prsCount,
    secretsCount: counts.secrets ?? BASELINE_FALLBACK_METRICS.secretsCount,
    reposCount: counts.repos ?? BASELINE_FALLBACK_METRICS.reposCount,
    scanAverage: ADVERTISED_SCAN_AVERAGE_SECONDS,
    isLive:
      counts.prs !== null &&
      counts.secrets !== null &&
      counts.repos !== null &&
      counts.scans !== null,
  };
}

/**
 * High-level landing page metrics.
 *
 * Every count degrades on its own: one failing query does not take the other
 * three with it, and the failure is visible through `isLive` rather than only
 * in the logs.
 */
export async function getLandingStats(): Promise<LandingStats> {
  try {
    return toLandingStats(await readLandingCounts());
  } catch (error) {
    // `readLandingCounts` swallows per-query failures, so reaching here means
    // something structural — the client itself is unusable.
    console.error("[LandingStats] Unexpected error querying database metrics:", error);
    return { ...BASELINE_FALLBACK_METRICS, isLive: false };
  }
}

/**
 * The full landing page security breakdown.
 *
 * Shares the base counts with {@link getLandingStats} instead of recomputing
 * them, so `totalScans` is the `ScanResult` count that was already paid for
 * rather than a second identical aggregate. That count used to be queried,
 * read once inside a boolean, and then dropped on the floor.
 */
export async function getDetailedLandingMetrics(): Promise<DetailedLandingMetrics> {
  let counts: LandingCounts;

  try {
    counts = await readLandingCounts();
  } catch (error) {
    console.error("[LandingStats] Unexpected error querying database metrics:", error);
    counts = { prs: null, secrets: null, repos: null, scans: null };
  }

  const baseStats = toLandingStats(counts);

  try {
    const [vulnCount, misconfigCount, blockedPrCount, passedPrCount] = await Promise.all([
      prisma.finding.count({ where: { type: "VULNERABILITY" } }).catch(() => 0),
      prisma.finding.count({ where: { type: "MISCONFIG" } }).catch(() => 0),
      prisma.pullRequest.count({ where: { status: "BLOCKED" } }).catch(() => 0),
      prisma.pullRequest.count({ where: { status: "PASS" } }).catch(() => 0),
    ]);

    return {
      ...baseStats,
      totalScans: counts.scans ?? 0,
      totalVulnerabilities: vulnCount,
      totalMisconfigs: misconfigCount,
      blockedPRs: blockedPrCount,
      passedPRs: passedPrCount,
    };
  } catch (error) {
    console.error("[LandingStats] Failed to retrieve detailed metrics:", error);
    return {
      ...baseStats,
      totalScans: counts.scans ?? 0,
      totalVulnerabilities: 0,
      totalMisconfigs: 0,
      blockedPRs: 0,
      passedPRs: 0,
    };
  }
}
