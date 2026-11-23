/**
 * Installation-level Role-Based Access Control (#1922)
 *
 * Defines the three canonical roles per installation:
 * - VIEWER: Read findings, analytics, reports, policies, audit logs.
 * - TRIAGER: All VIEWER permissions plus findings triage (dismiss, restore, notes, assign, remediate).
 * - ADMIN: Full access to everything, including policies, suppression rules, API tokens, settings, and member management.
 *
 * Existing users with role "USER" or repository owners keep their current full access as default.
 */

export type InstallationRole = "ADMIN" | "TRIAGER" | "VIEWER" | "USER";

export type PermissionAction =
  | "findings:read"
  | "findings:dismiss"
  | "findings:restore"
  | "findings:notes"
  | "findings:assign"
  | "findings:remediate"
  | "findings:create_issue"
  | "findings:delete"
  | "analytics:read"
  | "reports:read"
  | "policies:read"
  | "policies:edit"
  | "policies:toggle"
  | "suppression_rules:read"
  | "suppression_rules:manage"
  | "api_tokens:read"
  | "api_tokens:manage"
  | "settings:read"
  | "settings:edit"
  | "members:read"
  | "members:manage"
  | "audit:read";

export const ROLE_PERMISSIONS: Record<InstallationRole, ReadonlySet<PermissionAction>> = {
  VIEWER: new Set<PermissionAction>([
    "findings:read",
    "analytics:read",
    "reports:read",
    "policies:read",
    "suppression_rules:read",
    "api_tokens:read",
    "settings:read",
    "members:read",
    "audit:read",
  ]),
  TRIAGER: new Set<PermissionAction>([
    "findings:read",
    "analytics:read",
    "reports:read",
    "policies:read",
    "suppression_rules:read",
    "api_tokens:read",
    "settings:read",
    "members:read",
    "audit:read",
    // Triage capabilities
    "findings:dismiss",
    "findings:restore",
    "findings:notes",
    "findings:assign",
    "findings:remediate",
    "findings:create_issue",
  ]),
  ADMIN: new Set<PermissionAction>([
    "findings:read",
    "findings:dismiss",
    "findings:restore",
    "findings:notes",
    "findings:assign",
    "findings:remediate",
    "findings:create_issue",
    "findings:delete",
    "analytics:read",
    "reports:read",
    "policies:read",
    "policies:edit",
    "policies:toggle",
    "suppression_rules:read",
    "suppression_rules:manage",
    "api_tokens:read",
    "api_tokens:manage",
    "settings:read",
    "settings:edit",
    "members:read",
    "members:manage",
    "audit:read",
  ]),
  // Existing default role USER keeps full access so existing installations do not break
  USER: new Set<PermissionAction>([
    "findings:read",
    "findings:dismiss",
    "findings:restore",
    "findings:notes",
    "findings:assign",
    "findings:remediate",
    "findings:create_issue",
    "findings:delete",
    "analytics:read",
    "reports:read",
    "policies:read",
    "policies:edit",
    "policies:toggle",
    "suppression_rules:read",
    "suppression_rules:manage",
    "api_tokens:read",
    "api_tokens:manage",
    "settings:read",
    "settings:edit",
    "members:read",
    "members:manage",
    "audit:read",
  ]),
};

export interface UserRoleLike {
  id?: string;
  roles?: string[];
  role?: string;
  email?: string | null;
}

/**
 * Normalizes a user reference to their installation role.
 */
export function getUserRole(user: UserRoleLike | string | null | undefined): InstallationRole {
  if (!user) return "VIEWER";
  if (typeof user === "string") {
    const upper = user.toUpperCase().trim();
    if (upper === "ADMIN") return "ADMIN";
    if (upper === "TRIAGER") return "TRIAGER";
    if (upper === "VIEWER") return "VIEWER";
    if (upper === "USER") return "USER";
    return "VIEWER";
  }

  const roleList = (user.roles || (user.role ? [user.role] : [])).map((r) => r.toUpperCase());
  if (roleList.includes("ADMIN")) return "ADMIN";
  if (roleList.includes("TRIAGER")) return "TRIAGER";
  if (roleList.includes("VIEWER")) return "VIEWER";
  if (roleList.includes("USER")) return "USER";

  // Default for existing users / backward compatibility
  return "USER";
}

/**
 * Single permission helper: can(user, installation, action)
 *
 * Evaluates whether `user` has permission to execute `action` in `installation`.
 *
 * @example
 * if (!can(session.user, installationId, "findings:dismiss")) {
 *   return { ok: false, error: "Permission denied" };
 * }
 */
export function can(
  user: UserRoleLike | string | null | undefined,
  _installation: unknown,
  action: PermissionAction,
): boolean {
  if (!user) return false;
  const role = getUserRole(user);
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) return false;
  return permissions.has(action);
}

export class PermissionDeniedError extends Error {
  public statusCode: number = 403;
  public action: string;

  constructor(action: string, message?: string) {
    super(message || `Permission denied: action '${action}' requires higher privileges.`);
    this.name = "PermissionDeniedError";
    this.action = action;
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
  }
}

/**
 * Asserts that `user` has permission to execute `action` in `installation`,
 * throwing a `PermissionDeniedError` if denied.
 */
export function assertCan(
  user: UserRoleLike | string | null | undefined,
  installation: unknown,
  action: PermissionAction,
): void {
  if (!can(user, installation, action)) {
    throw new PermissionDeniedError(action);
  }
}
