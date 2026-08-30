"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";

export interface ScanJobRow {
  id: string;
  status: string;
  totalFiles: number;
  scannedFiles: number;
  vulnerabilitiesFound: number;
  riskScore: number | null;
  policyDecision: string | null;
  error: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  repoName: string;
  prNumber: number | null;
  prTitle: string | null;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export async function getScanJobs(userId: string, statusFilter: string) {
  const where: Record<string, unknown> = {
    repository: { userId },
  };

  if (statusFilter !== "all") {
    where.status = statusFilter.toUpperCase();
  }

  const [rows, pending, processing, completed, failed] = await Promise.all([
    prisma.scanJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        repository: { select: { fullName: true } },
        pullRequest: { select: { prNumber: true, title: true } },
      },
    }),
    prisma.scanJob.count({ where: { repository: { userId }, status: "PENDING" } }),
    prisma.scanJob.count({ where: { repository: { userId }, status: "PROCESSING" } }),
    prisma.scanJob.count({ where: { repository: { userId }, status: "COMPLETED" } }),
    prisma.scanJob.count({ where: { repository: { userId }, status: "FAILED" } }),
  ]);

  const jobs: ScanJobRow[] = rows.map((r: any) => ({
    id: r.id,
    status: r.status,
    totalFiles: r.totalFiles,
    scannedFiles: r.scannedFiles,
    vulnerabilitiesFound: r.vulnerabilitiesFound,
    riskScore: r.riskScore,
    policyDecision: r.policyDecision,
    error: r.error,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    repoName: r.repository?.fullName ?? "Unknown",
    prNumber: r.pullRequest?.prNumber ?? null,
    prTitle: r.pullRequest?.title ?? null,
  }));

  return {
    jobs,
    stats: { pending, processing, completed, failed } as QueueStats,
  };
}
