import prisma from "@/lib/prisma";
import DashboardClient from "./dashboard-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserTriage } from "@/lib/triage/queries";
import { findingCategoryFilter, severityFilter } from "@/lib/finding-taxonomy";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;

  // Dismissed (FALSE_POSITIVE / IGNORED) findings must not count toward the
  // finding tiles or the severity distribution. Exclude them by fingerprint.
  const { suppressedFingerprints } = await getUserTriage(userId);
  const notDismissed = { fingerprint: { notIn: suppressedFingerprints } };

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

  // Secret membership comes from `@/lib/finding-taxonomy` rather than from a
  // hand-grown list of exact-cased strings. `Finding.type` is stored verbatim
  // from the model response and is never normalised, so a row typed `"secret"`
  // or `"Credential Leak"` was counted as zero here while being listed on
  // /dashboard/findings (#590). The two pages also carried *different* lists,
  // so the same finding could be a secret on one page and nothing on the other.
  const secretsDetected = await prisma.finding.count({
    where: {
      type: findingCategoryFilter("SECRET"),
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
  //
  // Through `severityFilter` rather than `severity: 'CRITICAL'`. The column is
  // an unconstrained String; `iq.ts` documents that the exact match let a row
  // reading `"critical"` decide a pull request PASS, and
  // `leaderboard/aggregate.ts` compares on the trimmed, upper-cased value for
  // the same reason. This page was the last exact match left.
  const severityScope = {
    scanResult: { pullRequest: { repository: { userId } } },
    ...notDismissed,
  };

  const [critical, high, medium, low] = await Promise.all([
    prisma.finding.count({ where: { severity: severityFilter("CRITICAL"), ...severityScope } }),
    prisma.finding.count({ where: { severity: severityFilter("HIGH"), ...severityScope } }),
    prisma.finding.count({ where: { severity: severityFilter("MEDIUM"), ...severityScope } }),
    prisma.finding.count({ where: { severity: severityFilter("LOW"), ...severityScope } }),
  ]);

  // 4. FIX: Generate real Chart Data (Last 7 days of scans)
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
    />
  );
}