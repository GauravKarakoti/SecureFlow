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

export function computeForm(prs: { status: string; createdAt: Date }[]): FormResult[] {
  return prs
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5)
    .map((pr) => {
      if (pr.status === "PASS") return "W";
      if (pr.status === "REVIEW REQUIRED") return "D";
      return "L";
    });
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
