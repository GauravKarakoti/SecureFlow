import prisma from "@/lib/prisma";
import FindingsClient from "./findings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserTriage, triageKey } from "@/lib/triage/queries";
import { findingCategoryFilter, severityFilter } from "@/lib/finding-taxonomy";

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

  // Category membership comes from `@/lib/finding-taxonomy` rather than from a
  // list of exact-cased strings maintained here. `Finding.type` is written
  // verbatim from the model response and is never normalised, so
  // `type: { in: ['Vulnerability', 'Logic Flaw'] }` counted zero for a row typed
  // `"vulnerability"` or `"SQL Injection"` — while that same row was rendered in
  // the table below (#590). Severity goes through the same helper for the reason
  // `iq.ts` and `leaderboard/aggregate.ts` already document: the column is an
  // unconstrained String and an exact match silently misses.
  //
  // `OTHER` is a real fourth bucket rather than a silent drop, so the tiles
  // always sum to the number of findings.
  const [criticalSecrets, vulnerabilities, misconfigs, other] = await Promise.all([
    prisma.finding.count({
      where: {
        type: findingCategoryFilter("SECRET"),
        severity: severityFilter("CRITICAL"),
        ...ownedByUser,
        ...notDismissed,
      },
    }),
    prisma.finding.count({
      where: { type: findingCategoryFilter("VULNERABILITY"), ...ownedByUser, ...notDismissed },
    }),
    prisma.finding.count({
      where: { type: findingCategoryFilter("MISCONFIG"), ...ownedByUser, ...notDismissed },
    }),
    prisma.finding.count({
      where: { type: findingCategoryFilter("OTHER"), ...ownedByUser, ...notDismissed },
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