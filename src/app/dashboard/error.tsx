"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Dashboard segment error boundary (#560).
 *
 * Nested deliberately. `src/app/dashboard/layout.tsx` renders the sidebar,
 * header and mobile drawer; a boundary at this level replaces only the `<main>`
 * content, so when one Prisma query fails the navigation stays usable and the
 * user can move to a page that still works.
 *
 * That is the common case: `/dashboard/findings` alone issues three `count()`
 * queries plus a `findMany` with a nested include, and any one of them can fail
 * on its own.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] dashboard error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="This view failed to load"
      description="We could not read your security data just now. Your findings are unaffected — this is a problem reading them, not storing them."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
