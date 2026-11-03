"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

/**
 * Route-level error boundary for /admin/users (#1527).
 *
 * Catches user directory pagination, search, and role aggregation errors.
 * Ensures an admin cannot inadvertently leak user PII or SQL queries on failure,
 * while maintaining a seamless sidebar navigation experience.
 */
export default function AdminUsersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecureFlow] admin users error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <div className="space-y-4" data-testid="admin-users-error-boundary">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">User Management</h1>
        <p className="text-sm text-muted-foreground">
          Manage member accounts, assign RBAC privileges, and review active sessions.
        </p>
      </div>
      <ErrorState
        title="Failed to load user management"
        description="Unable to retrieve the user list and role memberships at this time. User permissions remain unaffected. Please retry or browse other administrative views."
        digest={error.digest}
        onRetry={reset}
        showDashboardLink={false}
        className="min-h-[45vh]"
      />
    </div>
  );
}
