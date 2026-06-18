import prisma from "@/lib/prisma";
import DashboardClient from "./dashboard-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const session = await auth();
  
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }
  
  const userId = session.user.id;

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
  
  // FIX: Categorize all variation of secrets
  const secretsDetected = await prisma.finding.count({ 
    where: { 
      type: { in: ['Secret', 'Hardcoded Secret', 'Data Leak', 'Contextual Leak'] }, 
      scanResult: { pullRequest: { repository: { userId } } } 
    } 
  });

  // 2. Fetch Recent Pull Requests
  const recentPRs = await prisma.pullRequest.findMany({
    where: { repository: { userId } },
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { repository: true }
  });

  // 3. Fetch Severity Distribution
  const critical = await prisma.finding.count({ 
    where: { severity: 'CRITICAL', scanResult: { pullRequest: { repository: { userId } } } } 
  });
  const high = await prisma.finding.count({ 
    where: { severity: 'HIGH', scanResult: { pullRequest: { repository: { userId } } } } 
  });
  const medium = await prisma.finding.count({ 
    where: { severity: 'MEDIUM', scanResult: { pullRequest: { repository: { userId } } } } 
  });
  const low = await prisma.finding.count({ 
    where: { severity: 'LOW', scanResult: { pullRequest: { repository: { userId } } } } 
  });

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
  const scansByDate = recentScans.reduce((acc: Record<string, number>, scan) => {
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