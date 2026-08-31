import AnalyticsClient from "./analytics-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getAnalyticsPayload } from "@/lib/analytics/scan-history";

export const dynamic = "force-dynamic";

/**
 * Security Analytics Dashboard (#analytics)
 *
 * Provides detailed scan history, trend analysis, repository comparison,
 * and exportable reports. Composes data from `getAnalyticsPayload` which
 * runs all queries in parallel for performance.
 */
export default async function AnalyticsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;
  const payload = await getAnalyticsPayload(userId, 30);

  return (
    <AnalyticsClient
      dailyMetrics={payload.dailyMetrics}
      severityTrend={payload.severityTrend}
      repoSummaries={payload.repoSummaries}
      topFindingTypes={payload.topFindingTypes}
      scanVelocity={payload.scanVelocity}
      summary={payload.summary}
    />
  );
}
