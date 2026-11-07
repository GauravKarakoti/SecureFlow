"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Findings list error boundary (#1486).
 *
 * `findings/page.tsx` is `force-dynamic` and awaits
 * `Promise.all([getUserFindings(query), getUserFindingFilters()])` on every
 * visit; without a segment boundary any Prisma failure fell through to the
 * dashboard-level boundary, unmounting the whole page instead of just this
 * pane. Only the digest is logged and shown: a Prisma failure's message can
 * carry the connection string.
 */
export default function FindingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] findings list error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not load findings"
      description="We hit a problem reading your findings just now. The findings themselves are unaffected, so try again in a moment."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
