import AnalyticsClient from "./analytics-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getAnalyticsPayload } from "@/lib/analytics/scan-history";
import { parseAnalyticsRange } from "@/lib/analytics/range";

export const dynamic = "force-dynamic";

/**
 * Security Analytics Dashboard (#analytics)
 *
 * Provides detailed scan history, trend analysis, repository comparison,
 * and exportable reports. Composes data from `getAnalyticsPayload` which
 * runs all queries in parallel for performance.
 *
 * The window (7, 30 or 90 days) is read from `?range=` rather than held in
 * client state, so a chosen view is bookmarkable and survives a reload — the
 * same approach as the findings page's filters.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;
  const params = (await searchParams) ?? {};
  const rangeDays = parseAnalyticsRange(params.range);
  const payload = await getAnalyticsPayload(userId, rangeDays);

  return (
    <AnalyticsClient
      rangeDays={rangeDays}
      dailyMetrics={payload.dailyMetrics}
      severityTrend={payload.severityTrend}
      repoSummaries={payload.repoSummaries}
      topFindingTypes={payload.topFindingTypes}
      scanVelocity={payload.scanVelocity}
      summary={payload.summary}
    />
  );
}
