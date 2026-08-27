import prisma from "@/lib/prisma";
import DashboardClient from "./dashboard-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getSuppressedFingerprints } from "@/lib/triage/queries";
import { syncUserRepositories } from "@/lib/github/sync-user-repos";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;

  // 0. Auto-sync repositories for returning users or check GitHub App status (#634)
  let repoCount = await prisma.repository.count({
    where: { userId, isActive: true }
  });

  let needsGitHubAppInstall = false;

  if (repoCount === 0) {
    try {
      const syncResult = await syncUserRepositories(
        userId,
        (session.user as any).githubLogin,
        (session as any).accessToken
      );
      if (syncResult.synced > 0) {
        repoCount = syncResult.synced;
      } else if (!syncResult.hasInstallation) {
        needsGitHubAppInstall = true;
      }
    } catch (e) {
      console.warn("[Dashboard] Automatic repo sync on login encountered an error:", e);
    }
  }

  // Dismissed (FALSE_POSITIVE / IGNORED) findings must not count toward the
  // finding tiles or the severity distribution. Exclude them by fingerprint.
  //
  // `getSuppressedFingerprints`, not `getUserTriage`: this page only ever read
  // the dismissed set, and the full lookup loaded every triage row the user
  // owns — including the free-text notes nothing here renders (#689).
  const { fingerprints: suppressedFingerprints } = await getSuppressedFingerprints(userId);
  const notDismissed =
    suppressedFingerprints.length > 0
      ? { fingerprint: { notIn: suppressedFingerprints } }
      : {};

  // 1. Fetch High-level Stats (Filtered by user's repositories)
  const totalScans = await prisma.scanResult.count({
    where: { pullRequest: { repository: { userId } } }
  });

  const blockedPRs = await prisma.pullRequest.count({
    where: { status: 'BLOCKED', repository: { userId } }
  });

  const approvedPRs = await prisma.pullRequest.count({
    where: { status: 'PASS', repository: { userId } }
  });

  // `Finding.type` and `Finding.severity` are Prisma enums (#633), so the
  // literals below are the column's own members and an exact match is the only
  // thing that is valid here — `findingCategoryFilter` / `severityFilter` build
  // the same filters and were imported here without ever being called (#686).
  const secretsDetected = await prisma.finding.count({
    where: {
      type: "SECRET",
      scanResult: { pullRequest: { repository: { userId } } },
      ...notDismissed
    }
  });

  // 2. Fetch Recent Pull Requests
  const recentPRsRaw = await prisma.pullRequest.findMany({
    where: { repository: { userId } },
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { repository: true }
  });
  const recentPRs = recentPRsRaw.map((pr: any) => ({
    ...pr,
    githubId: pr.githubId.toString(),
    repository: { ...pr.repository, githubId: pr.repository.githubId.toString() }
  }));

  // 3. Fetch Severity Distribution (dismissed findings excluded)
  const severityScope = {
    scanResult: { pullRequest: { repository: { userId } } },
    ...notDismissed,
  };

  const [critical, high, medium, low] = await Promise.all([
    prisma.finding.count({ where: { severity: "CRITICAL", ...severityScope } }),
    prisma.finding.count({ where: { severity: "HIGH", ...severityScope } }),
    prisma.finding.count({ where: { severity: "MEDIUM", ...severityScope } }),
    prisma.finding.count({ where: { severity: "LOW", ...severityScope } }),
  ]);

  // 4. Generate real Chart Data (Last 7 days of scans)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const recentScans = await prisma.scanResult.findMany({
    where: {
      createdAt: { gte: sevenDaysAgo },
      pullRequest: { repository: { userId } }
    },
    select: { createdAt: true }
  });

  // Group scans by date
  const scansByDate = recentScans.reduce((acc: Record<string, number>, scan: any) => {
    const date = scan.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    acc[date] = (acc[date] || 0) + 1;
    return acc;
  }, {});

  // Create an array representing the last 7 days sequentially
  const chartData = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { name: dateStr, scans: scansByDate[dateStr] || 0 };
  });

  const stats = { totalScans, blockedPRs, approvedPRs, secretsDetected };
  const distribution = { critical, high, medium, low };

  return (
    <DashboardClient 
      stats={stats} 
      prs={recentPRs} 
      distribution={distribution} 
      chartData={chartData} 
      repoCount={repoCount}
      needsGitHubAppInstall={needsGitHubAppInstall}
      githubAppUrl={process.env.GITHUB_APP_URL || '/setup'}
    />
  );
}