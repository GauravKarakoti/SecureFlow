import prisma from "@/lib/prisma";
import FindingsClient from "./findings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function FindingsPage() {
  const session = await auth();
  
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }
  
  const userId = session.user.id;

  // FIX: Map arrays of similar types to capture all variations 
  const criticalSecrets = await prisma.finding.count({
    where: { 
      type: { in: ['Secret', 'Hardcoded Secret', 'Data Leak', 'Contextual Leak'] }, 
      severity: 'CRITICAL',
      scanResult: { pullRequest: { repository: { userId } } }
    }
  });
  
  const vulnerabilities = await prisma.finding.count({
    where: { 
      type: { in: ['Vulnerability', 'Logic Flaw'] },
      scanResult: { pullRequest: { repository: { userId } } }
    }
  });

  const misconfigs = await prisma.finding.count({
    where: { 
      type: { in: ['Misconfig', 'Potential Misconfig'] },
      scanResult: { pullRequest: { repository: { userId } } }
    }
  });

  // Fetch the actual findings for this user's repos
  const findingsRaw = await prisma.finding.findMany({
    where: {
      scanResult: { pullRequest: { repository: { userId } } }
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      scanResult: {
        include: { pullRequest: true }
      }
    }
  });
  const findings = findingsRaw.map(f => ({
    ...f,
    scanResult: {
      ...f.scanResult,
      pullRequest: {
        ...f.scanResult.pullRequest,
        githubId: f.scanResult.pullRequest.githubId.toString()
      }
    }
  }));

  const stats = { criticalSecrets, vulnerabilities, misconfigs };

  return <FindingsClient findings={findings} stats={stats} />;
}