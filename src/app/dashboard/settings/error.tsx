"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Settings error boundary (#1486).
 *
 * `settings/page.tsx` is `force-dynamic` and awaits a three-way `Promise.all`
 * (`getSlackWebhook`, `getTeamsWebhook`, `getVoiceAlerts`) on every visit;
 * without a segment boundary any failure fell through to the dashboard-level
 * boundary, unmounting the whole page. Only the digest is logged and shown.
 */
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] settings page error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      title="Could not load settings"
      description="We hit a problem reading your settings just now. Your saved values are unaffected, so try again in a moment."
      digest={error.digest}
      onRetry={reset}
      showDashboardLink={false}
      className="min-h-[50vh]"
    />
  );
}
