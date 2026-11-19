import prisma from "@/lib/prisma";
import { getMailTransport, type MailTransport } from "@/lib/email/mail-transport";
import {
  renderDigestHtml,
  renderDigestText,
  type DigestRepoMetric,
  type DigestFindingTypeMetric,
  type SecurityDigestData,
} from "./email-template";

export interface GenerateDigestOptions {
  now?: Date;
  mailTransport?: MailTransport;
  force?: boolean;
  appUrl?: string;
}

export interface DigestGenerationResult {
  success?: boolean;
  skipped?: boolean;
  reason?: "opted_out" | "already_generated" | "no_repositories" | "error";
  digest?: any;
  error?: string;
  emailSent?: boolean;
}

export interface BatchDigestResult {
  totalUsers: number;
  generated: number;
  skipped: number;
  errors: Array<{ userId: string; error: string }>;
}

/**
 * Seven days in milliseconds.
 */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Calculate weekly metrics for a user's repositories without ever fetching or storing code snippets or secrets (#1788).
 */
export async function calculateDigestMetricsForUser(
  userId: string,
  startDate: Date,
  endDate: Date,
): Promise<{
  newFindingsCount: number;
  dismissedFindingsCount: number;
  resolvedFindingsCount: number;
  blockedPrsCount: number;
  topRepositories: DigestRepoMetric[];
  topFindingTypes: DigestFindingTypeMetric[];
}> {
  // 1. Fetch user repositories
  const repositories = await prisma.repository.findMany({
    where: { userId },
    select: { id: true, fullName: true, name: true },
  });

  if (repositories.length === 0) {
    return {
      newFindingsCount: 0,
      dismissedFindingsCount: 0,
      resolvedFindingsCount: 0,
      blockedPrsCount: 0,
      topRepositories: [],
      topFindingTypes: [],
    };
  }

  const repoIds = repositories.map((r: any) => r.id);

  // 2. Count new findings created during the period
  const newFindingsCount = await prisma.finding.count({
    where: {
      scanResult: {
        pullRequest: {
          repositoryId: { in: repoIds },
        },
      },
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  // 3. Count dismissed findings during the period
  const dismissedFindingsCount = await prisma.findingTriage.count({
    where: {
      repositoryId: { in: repoIds },
      status: { in: ["DISMISSED", "FALSE_POSITIVE", "IGNORED"] },
      updatedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  // 4. Count resolved findings during the period
  const resolvedFindingsCount = await prisma.findingTriage.count({
    where: {
      repositoryId: { in: repoIds },
      status: "RESOLVED",
      updatedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  // 5. Count BLOCKED PRs created or updated during the period
  const blockedPrsCount = await prisma.pullRequest.count({
    where: {
      repositoryId: { in: repoIds },
      status: "BLOCKED",
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
  });

  // 6. Calculate top 5 repositories by open findings count
  // First, get suppressed/resolved fingerprints per repo
  const suppressedTriages = await prisma.findingTriage.findMany({
    where: {
      repositoryId: { in: repoIds },
      status: { in: ["RESOLVED", "FALSE_POSITIVE", "IGNORED", "DISMISSED"] },
    },
    select: { repositoryId: true, fingerprint: true },
  });

  const suppressedSet = new Set(
    suppressedTriages.map((t: any) => `${t.repositoryId}::${t.fingerprint}`),
  );

  // Fetch open findings counts per repository
  const repoMetricsList: DigestRepoMetric[] = [];

  for (const repo of repositories) {
    const findings = await prisma.finding.findMany({
      where: {
        scanResult: {
          pullRequest: {
            repositoryId: repo.id,
          },
        },
      },
      select: { fingerprint: true },
    });

    const openCount = findings.filter(
      (f: any) => !suppressedSet.has(`${repo.id}::${f.fingerprint}`),
    ).length;

    repoMetricsList.push({
      repositoryId: repo.id,
      name: repo.fullName || repo.name,
      openCount,
    });
  }

  repoMetricsList.sort((a, b) => b.openCount - a.openCount);
  const topRepositories = repoMetricsList.slice(0, 5);

  // 7. Calculate top 5 recurring finding types across this user's repositories
  const findingsForTypes = await prisma.finding.findMany({
    where: {
      scanResult: {
        pullRequest: {
          repositoryId: { in: repoIds },
        },
      },
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    select: { type: true },
  });

  const typeCounts: Record<string, number> = {};
  for (const f of findingsForTypes) {
    typeCounts[f.type] = (typeCounts[f.type] || 0) + 1;
  }

  const topFindingTypes: DigestFindingTypeMetric[] = Object.entries(typeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    newFindingsCount,
    dismissedFindingsCount,
    resolvedFindingsCount,
    blockedPrsCount,
    topRepositories,
    topFindingTypes,
  };
}

/**
 * Generate, store, and optionally email a weekly security digest for a single user (#1788).
 */
export async function generateWeeklyDigestForUser(
  userId: string,
  options: GenerateDigestOptions = {},
): Promise<DigestGenerationResult> {
  const now = options.now || new Date();

  // 1. Fetch user and check opt-in status
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      codename: true,
      weeklyDigestEnabled: true,
    },
  });

  if (!user) {
    return { success: false, reason: "error", error: `User ${userId} not found` };
  }

  // Acceptance criteria: Users who opted out get nothing.
  if (!user.weeklyDigestEnabled) {
    return { skipped: true, reason: "opted_out" };
  }

  // Acceptance criteria: The digest is generated once per week per user and stored.
  const lastDigest = await prisma.securityDigest.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  if (lastDigest && !options.force) {
    const elapsedMs = now.getTime() - new Date(lastDigest.createdAt).getTime();
    if (elapsedMs < SEVEN_DAYS_MS) {
      return {
        skipped: true,
        reason: "already_generated",
        digest: lastDigest,
      };
    }
  }

  const startDate = new Date(now.getTime() - SEVEN_DAYS_MS);
  const endDate = now;

  // 2. Compute aggregate metrics (never queries or extracts code snippets / secrets)
  const metrics = await calculateDigestMetricsForUser(userId, startDate, endDate);

  // 3. Store the digest snapshot in the database
  let digest = await prisma.securityDigest.create({
    data: {
      userId,
      startDate,
      endDate,
      newFindingsCount: metrics.newFindingsCount,
      dismissedFindingsCount: metrics.dismissedFindingsCount,
      resolvedFindingsCount: metrics.resolvedFindingsCount,
      blockedPrsCount: metrics.blockedPrsCount,
      topRepositories: metrics.topRepositories as any,
      topFindingTypes: metrics.topFindingTypes as any,
    },
  });

  // 4. Optionally dispatch email if user has an email and transport is available
  let emailSent = false;
  if (user.email) {
    const mailTransport = options.mailTransport || getMailTransport();
    const digestData: SecurityDigestData = {
      id: digest.id,
      startDate: digest.startDate,
      endDate: digest.endDate,
      newFindingsCount: digest.newFindingsCount,
      dismissedFindingsCount: digest.dismissedFindingsCount,
      resolvedFindingsCount: digest.resolvedFindingsCount,
      blockedPrsCount: digest.blockedPrsCount,
      topRepositories: metrics.topRepositories,
      topFindingTypes: metrics.topFindingTypes,
    };

    const text = renderDigestText(digestData, user, options.appUrl);
    const html = renderDigestHtml(digestData, user, options.appUrl);

    const emailResult = await mailTransport.sendMail({
      to: user.email,
      subject: `🛡️ SecureFlow Weekly Security Digest [${startDate.toISOString().slice(0, 10)} - ${endDate.toISOString().slice(0, 10)}]`,
      text,
      html,
    });

    if (emailResult.success) {
      emailSent = true;
      digest = await prisma.securityDigest.update({
        where: { id: digest.id },
        data: { sentAt: now },
      });
    }
  }

  return {
    success: true,
    digest,
    emailSent,
  };
}

/**
 * Batch generate weekly security digests for all opted-in users (#1788).
 */
export async function generateAllWeeklyDigests(
  options: GenerateDigestOptions = {},
): Promise<BatchDigestResult> {
  const users = await prisma.user.findMany({
    where: { weeklyDigestEnabled: true },
    select: { id: true },
  });

  let generated = 0;
  let skipped = 0;
  const errors: Array<{ userId: string; error: string }> = [];

  for (const user of users) {
    try {
      const result = await generateWeeklyDigestForUser(user.id, options);
      if (result.success) {
        generated++;
      } else if (result.skipped) {
        skipped++;
      } else if (result.error) {
        errors.push({ userId: user.id, error: result.error });
      }
    } catch (err: any) {
      errors.push({ userId: user.id, error: err?.message || String(err) });
    }
  }

  return {
    totalUsers: users.length,
    generated,
    skipped,
    errors,
  };
}

/**
 * Retrieve paginated history of weekly digests for a given user (#1788).
 */
export async function getUserDigests(userId: string, limit: number = 20): Promise<any[]> {
  return prisma.securityDigest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 100),
  });
}

/**
 * Retrieve the latest weekly digest for a user (#1788).
 */
export async function getLatestDigest(userId: string): Promise<any | null> {
  return prisma.securityDigest.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}
