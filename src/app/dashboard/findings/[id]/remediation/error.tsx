"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Remediation error boundary (#1468).
 *
 * Catches render failures on the remediation page without taking down the
 * dashboard shell. Failed patch generation and PR creation are handled by the
 * page itself with toasts; this is for everything that escapes those handlers.
 */
export default function RemediationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] remediation error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Remediation is unavailable"
      description="Something went wrong while preparing the remediation view. Nothing was changed on your repository, so you can safely try again."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
