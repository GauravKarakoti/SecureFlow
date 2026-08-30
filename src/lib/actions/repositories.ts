"use server";

import prisma from "@/lib/prisma";

export interface RepoOverview {
  id: string;
  fullName: string;
  isActive: boolean;
  prCount: number;
  scanCount: number;
  totalFindings: number;
  openFindings: number;
  lastScanAt: Date | null;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
}

function classifyRisk(findings: { severity: string }[]): RepoOverview["riskLevel"] {
  if (findings.length === 0) return "none";
  const has = (s: string) => findings.some((f) => f.severity === s);
  if (has("CRITICAL")) return "critical";
  if (has("HIGH")) return "high";
  if (has("MEDIUM")) return "medium";
  return "low";
}

export async function getRepoOverviews(userId: string): Promise<RepoOverview[]> {
  const repos = await prisma.repository.findMany({
    where: { userId, isActive: true },
    include: {
      pullRequests: {
        include: {
          scans: {
            include: {
              findings: { select: { severity: true, id: true } },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      },
      triages: { select: { fingerprint: true, status: true } },
    },
  });

  return repos.map((repo) => {
    const allScans = repo.pullRequests.flatMap((pr) => pr.scans);
    const allFindings = allScans.flatMap((s) => s.findings);
    const dismissed = new Set(
      repo.triages
        .filter((t) => t.status === "FALSE_POSITIVE" || t.status === "IGNORED")
        .map((t) => t.fingerprint),
    );
    const openFindings = allFindings.filter((f) => !dismissed.has(f.fingerprint)).length;

    return {
      id: repo.id,
      fullName: repo.fullName,
      isActive: repo.isActive,
      prCount: repo.pullRequests.length,
      scanCount: allScans.length,
      totalFindings: allFindings.length,
      openFindings,
      lastScanAt: allScans.length > 0 ? allScans[0].createdAt : null,
      riskLevel: classifyRisk(allFindings),
    };
  });
}
