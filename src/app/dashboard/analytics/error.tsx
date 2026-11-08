"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Analytics error boundary (#1486).
 *
 * `analytics/page.tsx` is `force-dynamic` and awaits `getAnalyticsPayload(...)`
 * on every visit; without a segment boundary any failure fell through to the
 * dashboard-level boundary, unmounting the whole page. Only the digest is
 * logged and shown: a Prisma failure's message can carry the connection string.
 */
export default function AnalyticsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] analytics page error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not load analytics"
      description="We hit a problem computing your metrics just now. The underlying data is unaffected, so try again in a moment."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
