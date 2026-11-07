"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Status page error boundary (#1486).
 *
 * `status/page.tsx` awaits `runHealthCheck()`, which probes Postgres, Redis,
 * and the Groq API over the network — the most failure-prone page in the
 * dashboard. A probe that throws (rather than returning unhealthy) previously
 * took down the entire dashboard view via the parent boundary. Only the digest
 * is logged and shown.
 */
export default function StatusError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] status page error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not run the health check"
      description="The status probes hit a problem just now — that usually means a dependency is unhappy, which is exactly what this page reports on. Try again in a moment."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
