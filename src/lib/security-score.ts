/**
 * Security Score Engine — computes a 0–100 score per repository.
 *
 * Bands: 90–100 Fortress | 70–89 Guarded | 50–69 Exposed | 0–49 Breached
 * Components: severity (45%), resolution (25%), coverage (15%), trend (15%)
 */

import prisma from "@/lib/prisma";

export type ScoreBand = "Fortress" | "Guarded" | "Exposed" | "Breached";

export interface RepoSecurityScore {
  repoId: string;
  repoName: string;
  score: number;
  band: ScoreBand;
  breakdown: {
    severityScore: number;
    resolutionScore: number;
    coverageScore: number;
    trendScore: number;
  };
  findingCounts: { critical: number; high: number; medium: number; low: number };
  totalFindings: number;
  resolvedFindings: number;
  scanCount: number;
}

export interface ScoreTrendPoint {
  date: string;
  score: number;
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  CRITICAL: 40,
  HIGH: 25,
  MEDIUM: 12,
  LOW: 3,
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 90) return "Fortress";
  if (score >= 70) return "Guarded";
  if (score >= 50) return "Exposed";
  return "Breached";
}

function countBySeverity(findings: { severity: string }[]) {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const s = f.severity.toLowerCase();
    if (s in c) c[s as keyof typeof c]++;
  }
  return c;
}

function severityComponent(
  counts: { critical: number; high: number; medium: number; low: number },
  scanCount: number,
): number {
  const total = counts.critical + counts.high + counts.medium + counts.low;
  if (total === 0) return 100;
  const penalty =
    counts.critical * SEVERITY_WEIGHTS.CRITICAL +
    counts.high * SEVERITY_WEIGHTS.HIGH +
    counts.medium * SEVERITY_WEIGHTS.MEDIUM +
    counts.low * SEVERITY_WEIGHTS.LOW;
  return clamp(100 - (penalty / Math.max(scanCount, 1) / 300) * 100);
}

function resolutionComponent(resolved: number, total: number): number {
  if (total === 0) return 100;
  return clamp((resolved / total) * 100);
}

function coverageComponent(lastScanAt: Date | null): number {
  if (!lastScanAt) return 0;
  const days = (Date.now() - lastScanAt.getTime()) / 86_400_000;
  if (days <= 1) return 100;
  if (days >= 30) return 30;
  return clamp(100 - ((days - 1) / 29) * 70);
}

function trendComponent(recent: number, prior: number): number {
  if (recent === 0 && prior === 0) return 80;
  if (prior === 0) return recent > 0 ? 40 : 100;
  return clamp(100 - (recent / prior) * 50);
}

function composite(sev: number, res: number, cov: number, trd: number): number {
  return clamp(sev * 0.45 + res * 0.25 + cov * 0.15 + trd * 0.15);
}

export async function computeRepoScores(userId: string): Promise<RepoSecurityScore[]> {
  const repos = await prisma.repository.findMany({
    where: { userId, isActive: true },
    include: {
      pullRequests: {
        include: {
          scans: {
            include: { findings: { select: { severity: true, id: true } } },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });

  const now = Date.now();
  const weekAgo = new Date(now - 7 * 86_400_000);
  const twoWeeksAgo = new Date(now - 14 * 86_400_000);
  const scores: RepoSecurityScore[] = [];

  for (const repo of repos) {
    const allFindings = repo.pullRequests.flatMap((pr) =>
      pr.scans.flatMap((s) => s.findings),
    );
    const findingCounts = countBySeverity(allFindings);
    const totalFindings = allFindings.length;

    const triages = await prisma.findingTriage.findMany({
      where: { repositoryId: repo.id, status: { not: "OPEN" } },
      select: { fingerprint: true },
    });

    const scanCount = repo.pullRequests.reduce((a, pr) => a + pr.scans.length, 0);
    const allScans = repo.pullRequests.flatMap((pr) => pr.scans);
    const lastScanAt = allScans.length > 0 ? allScans[0].createdAt : null;

    const recentFindings = allFindings.filter((f) => {
      const scan = allScans.find((s) => s.findings.some((sf) => sf.id === f.id));
      return scan && scan.createdAt >= weekAgo;
    }).length;

    const priorFindings = allFindings.filter((f) => {
      const scan = allScans.find((s) => s.findings.some((sf) => sf.id === f.id));
      return scan && scan.createdAt >= twoWeeksAgo && scan.createdAt < weekAgo;
    }).length;

    const severityScore = severityComponent(findingCounts, scanCount);
    const resolutionScore = resolutionComponent(triages.length, totalFindings);
    const coverageScore = coverageComponent(lastScanAt);
    const trendScore = trendComponent(recentFindings, priorFindings);
    const score = composite(severityScore, resolutionScore, coverageScore, trendScore);

    scores.push({
      repoId: repo.id,
      repoName: repo.fullName,
      score,
      band: scoreBand(score),
      breakdown: { severityScore, resolutionScore, coverageScore, trendScore },
      findingCounts,
      totalFindings,
      resolvedFindings: triages.length,
      scanCount,
    });
  }

  return scores.sort((a, b) => b.score - a.score);
}

export async function computeGlobalScore(userId: string) {
  const repoScores = await computeRepoScores(userId);
  if (repoScores.length === 0) return { score: 0, band: "Breached" as ScoreBand, repoScores: [] };
  const avg = Math.round(repoScores.reduce((s, r) => s + r.score, 0) / repoScores.length);
  return { score: avg, band: scoreBand(avg), repoScores };
}

export async function computeScoreTrend(userId: string, repoId: string): Promise<ScoreTrendPoint[]> {
  const repo = await prisma.repository.findFirst({
    where: { id: repoId, userId },
    include: {
      pullRequests: {
        include: {
          scans: {
            include: { findings: { select: { severity: true, createdAt: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  if (!repo) return [];
  const allScans = repo.pullRequests.flatMap((pr) => pr.scans);
  const points: ScoreTrendPoint[] = [];

  for (let i = 29; i >= 0; i--) {
    const cutoff = new Date(Date.now() - i * 86_400_000);
    const label = cutoff.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const scansToDate = allScans.filter((s) => s.createdAt <= cutoff);
    const findingsToDate = scansToDate.flatMap((s) => s.findings);
    const counts = countBySeverity(findingsToDate);
    const lastScan = scansToDate.length > 0 ? scansToDate.slice(-1)[0].createdAt : null;
    const sev = severityComponent(counts, scansToDate.length);
    const cov = coverageComponent(lastScan);
    points.push({ date: label, score: composite(sev, 50, cov, 80) });
  }
  return points;
}
