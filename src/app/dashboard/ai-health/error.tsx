"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * AI health error boundary (#1486).
 *
 * `ai-health/page.tsx` awaits `getAiHealthReport()` — which reads circuit
 * breaker state and telemetry — before rendering; without a segment boundary
 * any failure fell through to the dashboard-level boundary, unmounting the
 * whole page. Only the digest is logged and shown.
 */
export default function AiHealthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] AI health page error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not load AI health"
      description="We hit a problem reading model health just now — that usually means a provider is unhappy, which is exactly what this page reports on. Try again in a moment."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
