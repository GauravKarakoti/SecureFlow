import prisma from "@/lib/prisma";

export interface ScanSeverityTrendItem {
  id: string;
  createdAt: string;
  date: string;
  prNumber: number;
  prTitle: string;
  riskScore: number;
  policyDecision: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

export interface RepositoryScanTrendResponse {
  repositoryId: string;
  repositoryName: string;
  rangeDays: number;
  totalScans: number;
  scans: ScanSeverityTrendItem[];
}

export type ScanTrendResult =
  | {
      ok: true;
      data: RepositoryScanTrendResponse;
    }
  | {
      ok: false;
      status: 400 | 404 | 500;
      error: string;
    };

/**
 * Fetch chronological scan results and severity counts for a given repository and time window.
 *
 * @param repositoryId The repository ID to query
 * @param userId The ID of the authenticated user to enforce repository ownership
 * @param days The time window in days (7, 30, or 90; defaults to 30)
 */
export async function getRepositoryScanSeverityTrend(
  repositoryId: string,
  userId: string,
  days: number = 30,
): Promise<ScanTrendResult> {
  if (!repositoryId || typeof repositoryId !== "string" || !repositoryId.trim()) {
    return {
      ok: false,
      status: 400,
      error: "Repository ID is required",
    };
  }

  // Validate or normalize range days
  const validDays = [7, 30, 90].includes(days) ? days : 30;

  // Verify ownership: Repository must belong to the user
  const repository = await prisma.repository.findFirst({
    where: {
      id: repositoryId.trim(),
      userId,
    },
    select: {
      id: true,
      fullName: true,
      owner: true,
    },
  });

  if (!repository) {
    return {
      ok: false,
      status: 404,
      error: "Repository not found",
    };
  }

  const cutoffDate = new Date(Date.now() - validDays * 24 * 60 * 60 * 1000);

  // Retrieve scans in chronological order (createdAt: asc)
  const scanResults = await prisma.scanResult.findMany({
    where: {
      pullRequest: {
        repositoryId: repository.id,
      },
      createdAt: {
        gte: cutoffDate,
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      riskScore: true,
      policyDecision: true,
      createdAt: true,
      pullRequest: {
        select: {
          id: true,
          prNumber: true,
          title: true,
        },
      },
      findings: {
        select: {
          id: true,
          severity: true,
          type: true,
        },
      },
    },
  });

  const formattedScans: ScanSeverityTrendItem[] = scanResults.map((scan: any) => {
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let info = 0;

    for (const finding of scan.findings) {
      switch (finding.severity) {
        case "CRITICAL":
          critical++;
          break;
        case "HIGH":
          high++;
          break;
        case "MEDIUM":
          medium++;
          break;
        case "LOW":
          low++;
          break;
        case "INFO":
          info++;
          break;
      }
    }

    const total = critical + high + medium + low + info;
    const createdAtIso =
      scan.createdAt instanceof Date ? scan.createdAt.toISOString() : String(scan.createdAt);
    const dateStr = createdAtIso.split("T")[0];

    return {
      id: scan.id,
      createdAt: createdAtIso,
      date: dateStr,
      prNumber: scan.pullRequest?.prNumber ?? 0,
      prTitle: scan.pullRequest?.title ?? "",
      riskScore: scan.riskScore,
      policyDecision: String(scan.policyDecision),
      critical,
      high,
      medium,
      low,
      info,
      total,
    };
  });

  return {
    ok: true,
    data: {
      repositoryId: repository.id,
      repositoryName: repository.fullName,
      rangeDays: validDays,
      totalScans: formattedScans.length,
      scans: formattedScans,
    },
  };
}
