"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Audit log error boundary (#1486).
 *
 * `audit/page.tsx` awaits a four-way `Promise.all` (audit logs, filters, and
 * two Prisma `count()` calls); without a segment boundary any one of them
 * failing fell through to the dashboard-level boundary and unmounted the whole
 * page. Sits inside the dashboard layout so the sidebar keeps working. Only
 * the digest is logged and shown: a Prisma failure's message can carry the
 * connection string.
 */
export default function AuditError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] audit log error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not load the audit log"
      description="We hit a problem reading the audit log just now. The underlying events are unaffected, so try again in a moment."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
