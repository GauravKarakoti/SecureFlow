"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";

export async function getAdminMetrics() {
  const session = await auth();
  
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const [totalUsers, totalPrs, totalAudits] = await Promise.all([
    prisma.user.count(),
    prisma.pullRequest.count(),
    prisma.auditLog.count()
  ]);

  return { totalUsers, totalPrs, totalAudits };
}
export async function getRecentAuditLogs() {
  const session = await auth();

  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  return await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 100
  });
}
