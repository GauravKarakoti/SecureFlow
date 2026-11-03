"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Route-level error boundary for /admin/queue (#1527).
 *
 * Captures BullMQ/Redis worker connection failures and queue metric retrieval errors.
 * Preserves access to adjacent views (logs, users, overview) while highlighting the
 * transient worker connection failure without exposing Redis auth secrets or hostnames.
 */
export default function AdminQueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] admin queue error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <div className="space-y-4" data-testid="admin-queue-error-boundary">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Queue Management</h1>
        <p className="text-sm text-muted-foreground">
          Monitor background jobs, worker health, and retry dead-letter queues.
        </p>
      </div>
      <ErrorState
        title="Failed to load queue metrics"
        description="Could not communicate with the BullMQ / Redis background worker queue. Background jobs currently running will continue processing. Try again or check the system logs."
        digest={error.digest}
        onRetry={reset}
        showDashboardLink={false}
        className="min-h-[45vh]"
      />
    </div>
  );
}
