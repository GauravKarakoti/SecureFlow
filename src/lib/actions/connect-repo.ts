"use server";

/**
 * Server Actions for Connect Repository Wizard & Scan Verification (#2230)
 */

import { auth } from "@/auth";
import prisma from "@/lib/prisma";

export interface ConnectableRepository {
  id: string;
  fullName: string;
  owner: string;
  hasScans: boolean;
  lastScanAt: string | null;
}

export interface RepositoryScanStatus {
  hasScan: boolean;
  scan?: {
    id: string;
    createdAt: string;
    riskScore: number;
    policyDecision: string;
    findingsCount: number;
    prNumber?: number;
    headSha?: string | null;
  } | null;
}

/**
 * List connectable repositories belonging to the authenticated user.
 */
export async function getConnectableRepositories(): Promise<{
  repositories: ConnectableRepository[];
  error?: string;
}> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { repositories: [], error: "Unauthorized" };
  }

  const repos = await prisma.repository.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      fullName: true,
      owner: true,
      pullRequests: {
        select: {
          scans: {
            take: 1,
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          },
        },
      },
    },
    orderBy: { fullName: "asc" },
  });

  const formatted: ConnectableRepository[] = (repos as Array<{
    id: string;
    fullName: string;
    owner: string;
    pullRequests: Array<{ scans: Array<{ createdAt: Date }> }>;
  }>).map((r) => {
    const scans = r.pullRequests.flatMap((pr) => pr.scans);
    scans.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latestScan = scans[0];
    return {
      id: r.id,
      fullName: r.fullName,
      owner: r.owner,
      hasScans: Boolean(latestScan),
      lastScanAt: latestScan ? latestScan.createdAt.toISOString() : null,
    };
  });

  return { repositories: formatted };
}

/**
 * Check if at least one scan has arrived for the specified repository.
 */
export async function checkRepositoryScanStatus(
  repoFullNameOrId: string,
): Promise<RepositoryScanStatus> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { hasScan: false };
  }

  const trimmed = repoFullNameOrId.trim();
  if (!trimmed) {
    return { hasScan: false };
  }

  // Look up repository by ID or fullName
  const repo = await prisma.repository.findFirst({
    where: {
      userId,
      OR: [
        { id: trimmed },
        { fullName: { equals: trimmed, mode: "insensitive" } },
      ],
    },
    include: {
      pullRequests: {
        include: {
          scans: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              findings: {
                select: { id: true, severity: true },
              },
            },
          },
        },
      },
    },
  });

  if (!repo) {
    return { hasScan: false };
  }

  const allScans = (repo.pullRequests as Array<{
    prNumber: number;
    scans: Array<{
      id: string;
      createdAt: Date;
      riskScore: number;
      policyDecision: string;
      headSha: string | null;
      findings: Array<{ id: string; severity: string }>;
    }>;
  }>).flatMap((pr) =>
    pr.scans.map((s) => ({ ...s, prNumber: pr.prNumber })),
  );
  allScans.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const latest = allScans[0];
  if (!latest) {
    return { hasScan: false };
  }

  return {
    hasScan: true,
    scan: {
      id: latest.id,
      createdAt: latest.createdAt.toISOString(),
      riskScore: latest.riskScore,
      policyDecision: latest.policyDecision,
      findingsCount: latest.findings.length,
      prNumber: latest.prNumber,
      headSha: latest.headSha,
    },
  };
}

/**
 * Record a simulated scan for demonstration, sandbox, or automated test verification.
 */
export async function recordSimulatedScan(
  repoFullNameOrId: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { success: false, error: "Unauthorized" };
  }

  const trimmed = repoFullNameOrId.trim();
  if (!trimmed) {
    return { success: false, error: "Repository name is required" };
  }

  let repo = await prisma.repository.findFirst({
    where: {
      userId,
      OR: [
        { id: trimmed },
        { fullName: { equals: trimmed, mode: "insensitive" } },
      ],
    },
  });

  if (!repo) {
    const parts = trimmed.split("/");
    const owner = parts.length > 1 ? parts[0] : (session.user?.name || "developer");
    repo = await prisma.repository.create({
      data: {
        userId,
        githubId: BigInt(Date.now()),
        fullName: trimmed.includes("/") ? trimmed : `${owner}/${trimmed}`,
        owner,
        isActive: true,
      },
    });
  }

  let pr = await prisma.pullRequest.findFirst({
    where: { repositoryId: repo.id, prNumber: 1 },
  });

  if (!pr) {
    pr = await prisma.pullRequest.create({
      data: {
        repositoryId: repo.id,
        githubId: BigInt(Date.now()),
        prNumber: 1,
        title: "Initial SecureFlow Integration",
        state: "OPEN",
        status: "APPROVED",
        authorLogin: (session.user as { githubLogin?: string })?.githubLogin || session.user?.name || "developer",
      },
    });
  }

  const scan = await prisma.scanResult.create({
    data: {
      pullRequestId: pr.id,
      riskScore: 98,
      policyDecision: "PASSED",
      headSha: "a1b2c3d4e5f6",
      scanType: "PR",
    },
  });

  return {
    success: true,
    message: `Simulated scan ${scan.id} created successfully for ${repo.fullName}`,
  };
}

