"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Route-level error boundary for /admin/logs (#1527).
 *
 * Catches data retrieval errors specifically related to the audit logs table and
 * log export pipelines. Ensures other admin tabs remain fully accessible and functional.
 * Redacts any connection string or sensitive database parameters by exposing only
 * the Next.js error digest for telemetry correlation.
 */
export default function AdminLogsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] admin logs error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <div className="space-y-4" data-testid="admin-logs-error-boundary">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          System activity, compliance audit trails, and administrative events.
        </p>
      </div>
      <ErrorState
        title="Failed to load audit logs"
        description="We encountered an issue fetching the administrative audit events. No logs were deleted or altered. You can try refreshing the log view or check other admin panels using the navigation sidebar."
        digest={error.digest}
        onRetry={reset}
        showDashboardLink={false}
        className="min-h-[45vh]"
      />
    </div>
  );
}
