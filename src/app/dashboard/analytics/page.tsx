import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { computeGlobalScore, computeScoreTrend } from "@/lib/security-score";
import AnalyticsClient from "./analytics-client";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const userId = session.user.id;
  const { score, band, repoScores } = await computeGlobalScore(userId);

  // Compute trend for the top repo (if any) for the sparkline
  let trendData: { date: string; score: number }[] = [];
  if (repoScores.length > 0) {
    trendData = await computeScoreTrend(userId, repoScores[0].repoId);
  }

  return (
    <AnalyticsClient
      globalScore={score}
      globalBand={band}
      repoScores={repoScores}
      trendData={trendData}
    />
  );
}
