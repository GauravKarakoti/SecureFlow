export type SeverityCounts = { critical: number; high: number; medium: number; low: number };

export type RepoMetrics = {
  totalPRs: number;
  passedPRs: number;
  findings: SeverityCounts;
  daysSinceLastCritical: number | null;
};

export type Badge = { emoji: string; label: string };

export function computeSecurityScore(m: RepoMetrics): number {
  const penalty = Math.min(
    60,
    m.findings.critical * 10 + m.findings.high * 5 + m.findings.medium * 2 + m.findings.low * 1
  );

  const passRate = m.totalPRs > 0 ? m.passedPRs / m.totalPRs : 1;
  const passBonus = Math.round(passRate * 20);

  const streakBonus =
    m.daysSinceLastCritical === null ? 20 : m.daysSinceLastCritical >= 30 ? 20 : m.daysSinceLastCritical >= 7 ? 10 : 0;

  return Math.max(0, Math.min(100, 40 + passBonus + streakBonus - penalty + 20));
}

export type FormResult = "W" | "D" | "L";

/**
 * The `PRStatus` members, as they are spelled in `prisma/schema.prisma`.
 *
 * There are two vocabularies for a pull request's outcome in this codebase and
 * they are not the same strings:
 *
 *  - `ArmorIQPolicyEngine.evaluateFindings` returns `PolicyResult`, whose
 *    middle member is the human label `"REVIEW REQUIRED"` — with a space.
 *  - `PullRequest.status` stores the Prisma enum, whose middle member is
 *    `REVIEW_REQUIRED` — with an underscore. `normalizePrStatusEnum` is the
 *    function that converts one into the other on the way to the database.
 *
 * `computeForm` reads rows that have already been through that conversion, and
 * compared them against the pre-conversion label. `PASS` and `BLOCKED` happen
 * to be spelled identically in both vocabularies, so only the middle case was
 * wrong — and it was wrong silently, scoring every reviewed pull request as a
 * loss (#703).
 */
export const PR_STATUS = {
  PASS: "PASS",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  BLOCKED: "BLOCKED",
} as const;

export type StoredPrStatus = (typeof PR_STATUS)[keyof typeof PR_STATUS];

/**
 * Interpret a stored status, tolerating the policy engine's spacing.
 *
 * `REVIEW REQUIRED`, `REVIEW_REQUIRED`, `review-required` and `Review Required`
 * all mean the same thing. Normalising separators away means a row written by
 * an older build, or by a code path that stored the label rather than the enum,
 * is still read correctly instead of being quietly demoted to a loss — which is
 * exactly the failure mode this replaces.
 *
 * Returns null for a value that means nothing to us, so the caller decides what
 * an unknown status is worth rather than having "not a pass" assumed for it.
 */
export function parsePrStatus(status: unknown): StoredPrStatus | null {
  if (typeof status !== "string") return null;

  const clean = status.trim().toUpperCase().replace(/[\s_-]+/g, "");

  if (clean === "PASS") return PR_STATUS.PASS;
  if (clean === "REVIEWREQUIRED") return PR_STATUS.REVIEW_REQUIRED;
  if (clean === "BLOCKED" || clean === "BLOCK") return PR_STATUS.BLOCKED;

  return null;
}

/**
 * The single-letter form entry for one pull request status.
 *
 * An unrecognised status is an `L`, matching the previous fall-through. That is
 * the conservative direction for a public scoreboard: an outcome we cannot
 * interpret should not be presented as a win.
 */
export function formResultFor(status: unknown): FormResult {
  switch (parsePrStatus(status)) {
    case PR_STATUS.PASS:
      return "W";
    case PR_STATUS.REVIEW_REQUIRED:
      return "D";
    default:
      return "L";
  }
}

export function computeForm(prs: { status: string; createdAt: Date }[]): FormResult[] {
  return prs
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5)
    .map((pr) => formResultFor(pr.status));
}

export function computeBadges(m: RepoMetrics): Badge[] {
  const badges: Badge[] = [];
  const total = m.findings.critical + m.findings.high + m.findings.medium + m.findings.low;
  if (total === 0) badges.push({ emoji: "🛡️", label: "Zero Vulnerabilities" });
  if (m.daysSinceLastCritical === null || m.daysSinceLastCritical >= 30)
    badges.push({ emoji: "🔥", label: "30-Day Clean Streak" });
  if (m.totalPRs > 0 && m.passedPRs === m.totalPRs)
    badges.push({ emoji: "✅", label: "Perfect Pass Rate" });
  if (m.findings.critical === 0 && total > 0)
    badges.push({ emoji: "🟢", label: "No Criticals" });
  return badges;
}

// ── Contributor leaderboard ──────────────────────────────────────────────
// Ranks developers by the security performance of their PRs: fewer
// vulnerabilities introduced and more fixes merged score higher (Issue #121).

export type ContributorMetrics = {
  totalPRs: number;
  mergedPRs: number;
  passedPRs: number;
  vulnsIntroduced: SeverityCounts;
};

export function computeContributorScore(m: ContributorMetrics): number {
  // Weighted penalty for vulnerabilities the author's PRs introduced.
  const penalty = Math.min(
    60,
    m.vulnsIntroduced.critical * 8 +
      m.vulnsIntroduced.high * 4 +
      m.vulnsIntroduced.medium * 2 +
      m.vulnsIntroduced.low * 1
  );

  const passRate = m.totalPRs > 0 ? m.passedPRs / m.totalPRs : 1;
  const passBonus = Math.round(passRate * 25);

  // Reward shipping merged, clean work (capped so volume alone can't dominate).
  const mergedBonus = Math.min(15, m.mergedPRs * 2);

  return Math.max(0, Math.min(100, 40 + passBonus + mergedBonus - penalty));
}

export function computeContributorBadges(m: ContributorMetrics): Badge[] {
  const badges: Badge[] = [];
  const totalVulns =
    m.vulnsIntroduced.critical +
    m.vulnsIntroduced.high +
    m.vulnsIntroduced.medium +
    m.vulnsIntroduced.low;
  if (totalVulns === 0 && m.totalPRs > 0)
    badges.push({ emoji: "🥷", label: "Zero Vulns Introduced" });
  if (m.totalPRs > 0 && m.passedPRs === m.totalPRs)
    badges.push({ emoji: "✅", label: "Clean Record" });
  if (m.vulnsIntroduced.critical === 0 && totalVulns > 0)
    badges.push({ emoji: "🟢", label: "No Criticals" });
  if (m.mergedPRs >= 5) badges.push({ emoji: "🔧", label: "Prolific Merger" });
  return badges;
}

/**
 * Dense ranking: rows sharing a score share a rank.
 * Input need not be pre-sorted; output is sorted by score desc.
 * e.g. scores [100, 90, 90, 80] -> ranks [1, 2, 2, 3]
 */
export function assignRanks<T extends { score: number }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  let rank = 0;
  let prevScore = Number.POSITIVE_INFINITY;
  return sorted.map((row) => {
    if (row.score < prevScore) {
      rank += 1;
      prevScore = row.score;
    }
    return { ...row, rank };
  });
}

// ── Money Heist Bounty Formatting ────────────────────────────────────────
/**
 * Formats a numeric score as a Euro-denominated bounty string.
 * €10,000 per point, minimum €10K.
 */
export function formatBounty(score: number): string {
  const raw = Math.max(1, score) * 10_000;
  if (raw >= 1_000_000) {
    const m = raw / 1_000_000;
    return `€${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  const k = raw / 1_000;
  return `€${k % 1 === 0 ? k : k.toFixed(1)}K`;
}
