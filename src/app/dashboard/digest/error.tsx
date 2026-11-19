"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

export default function DigestError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] digest page error", error);
  }, [error]);

  return (
    <ErrorState
      title="Failed to load security digests"
      description="We encountered an issue retrieving your security digest history. Please try again or refresh the page."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={true}
      className="min-h-[50vh]"
    />
  );
}
