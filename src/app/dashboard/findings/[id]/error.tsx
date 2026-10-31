"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Finding detail error boundary (#1468).
 *
 * Sits inside the dashboard layout, so a failed finding lookup replaces only
 * this page and the sidebar keeps working. Only the digest is logged and shown:
 * a Prisma failure's message can carry the connection string.
 */
export default function FindingDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] finding detail error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not load this finding"
      description="We hit a problem reading this finding just now. The finding itself is unaffected, so try again or head back to the list."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
