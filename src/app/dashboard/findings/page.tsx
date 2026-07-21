import prisma from "@/lib/prisma";
import FindingsClient from "./findings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserTriage, triageKey } from "@/lib/triage/queries";

export const dynamic = "force-dynamic";

export default async function FindingsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;

  // Dismissed (FALSE_POSITIVE / IGNORED) findings are excluded from the tiles
  // by fingerprint; `byKey` carries each finding's current status into the UI.
  const { suppressedFingerprints, byKey } = await getUserTriage(userId);
  const notDismissed = { fingerprint: { notIn: suppressedFingerprints } };

  // FIX: Map arrays of similar types to capture all variations
  const criticalSecrets = await prisma.finding.count({
    where: {
      type: { in: ['Secret', 'Hardcoded Secret', 'Data Leak', 'Contextual Leak'] },
      severity: 'CRITICAL',
      scanResult: { pullRequest: { repository: { userId } } },
      ...notDismissed
    }
  });

  const vulnerabilities = await prisma.finding.count({
    where: {
      type: { in: ['Vulnerability', 'Logic Flaw'] },
      scanResult: { pullRequest: { repository: { userId } } },
      ...notDismissed
    }
  });

  const misconfigs = await prisma.finding.count({
    where: {
      type: { in: ['Misconfig', 'Potential Misconfig'] },
      scanResult: { pullRequest: { repository: { userId } } },
      ...notDismissed
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
  const findings = findingsRaw.map((f: any) => {
    const repositoryId = f.scanResult.pullRequest.repositoryId;
    const triage = byKey.get(triageKey(repositoryId, f.fingerprint));
    return {
      ...f,
      repositoryId,
      triageStatus: triage?.status ?? 'OPEN',
      triageNote: triage?.note ?? null,
      scanResult: {
        ...f.scanResult,
        pullRequest: {
          ...f.scanResult.pullRequest,
          githubId: f.scanResult.pullRequest.githubId.toString()
        }
      }
    };
  });

  const stats = { criticalSecrets, vulnerabilities, misconfigs };

  return <FindingsClient findings={findings} stats={stats} />;
}