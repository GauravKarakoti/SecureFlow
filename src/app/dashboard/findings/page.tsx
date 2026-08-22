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

  // Scope shared by every tile, so no tile can disagree with its siblings about
  // which repositories it is counting.
  const ownedByUser = { scanResult: { pullRequest: { repository: { userId } } } };

  // The database schema now enforces `FindingType` and `Severity` as Enums.
  // For the "other" bucket, we simply exclude the known Enum values.
  const [criticalSecrets, vulnerabilities, misconfigs, other] = await Promise.all([
    prisma.finding.count({
      where: {
        type: "SECRET",
        severity: "CRITICAL",
        ...ownedByUser,
        ...notDismissed,
      },
    }),
    prisma.finding.count({
      where: { type: "VULNERABILITY", ...ownedByUser, ...notDismissed },
    }),
    prisma.finding.count({
      where: { type: "MISCONFIG", ...ownedByUser, ...notDismissed },
    }),
    prisma.finding.count({
      where: { 
        type: { notIn: ["SECRET", "VULNERABILITY", "MISCONFIG"] }, 
        ...ownedByUser, 
        ...notDismissed 
      },
    }),
  ]);

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

  const stats = { criticalSecrets, vulnerabilities, misconfigs, other };

  return <FindingsClient findings={findings} stats={stats} />;
}