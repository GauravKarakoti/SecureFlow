"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Root segment error boundary (#560).
 *
 * Catches anything thrown while rendering a route under the root layout —
 * `/leaderboard` and `/share/heist` do unguarded Prisma reads, and the landing
 * page renders `InteractiveDemo`. Before this existed, all of those fell
 * through to Next's unstyled built-in fallback with no retry affordance.
 *
 * Must be a client component: `reset()` is a function prop, and only a client
 * boundary can hold one.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaces the digest in the browser console next to the same digest in the
    // server log, which is the only thing tying the two together.
    console.error("[SecureFlow] route error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <ErrorState
      code="500"
      title="Signal lost"
      description="Something went wrong while loading this page. The incident has been logged. Retrying often works — this is usually a transient database or upstream hiccup."
      digest={error.digest}
      onRetry={reset}
      showHomeLink
    />
  );
}
