import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getUserDigests } from "@/lib/digest/digest-service";
import { getWeeklyDigestPreference } from "@/lib/actions/settings";
import DigestClient, { type SerializedDigest } from "./digest-client";

export const dynamic = "force-dynamic";

export default async function DigestPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;

  const [rawDigests, digestEnabled] = await Promise.all([
    getUserDigests(userId, 50),
    getWeeklyDigestPreference(),
  ]);

  const digests: SerializedDigest[] = rawDigests.map((d) => ({
    id: d.id,
    startDate: d.startDate.toISOString(),
    endDate: d.endDate.toISOString(),
    newFindingsCount: d.newFindingsCount,
    dismissedFindingsCount: d.dismissedFindingsCount,
    resolvedFindingsCount: d.resolvedFindingsCount,
    blockedPrsCount: d.blockedPrsCount,
    topRepositories: (d.topRepositories as any) || [],
    topFindingTypes: (d.topFindingTypes as any) || [],
    sentAt: d.sentAt ? d.sentAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  }));

  return (
    <DigestClient
      initialDigests={digests}
      weeklyDigestEnabled={digestEnabled}
      userEmail={session.user.email ?? null}
      userName={session.user.name ?? null}
    />
  );
}
