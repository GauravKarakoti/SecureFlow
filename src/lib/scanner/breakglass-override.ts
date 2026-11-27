/**
 * Break-Glass Override Label & Policy (#2094)
 *
 * Implements emergency override mechanism for false-positive or urgent releases:
 * - Configurable PR label (defaults to "secureflow:override" or "security-override")
 * - User authorization check against configured roles/usernames (e.g., admin, security-team, maintainer, write)
 * - Required comment containing justification / reason
 * - Expiration after a configurable duration (e.g., 2 hours / 120 minutes)
 * - Expiration / invalidation when new commits are pushed after the override
 * - Audit logging to database and audit ledger
 * - Check run conclusion set to "success" with prominent "overridden" note
 */

import prisma from "@/lib/prisma";

export const DEFAULT_OVERRIDE_LABEL = "secureflow:override";
export const DEFAULT_OVERRIDE_EXPIRY_MINUTES = 120; // 2 hours

export interface BreakglassConfig {
  /** Whether the break-glass override feature is enabled. Defaults to true if config is present or label used. */
  enabled?: boolean;
  /** Label name that triggers the override check. Defaults to "secureflow:override". */
  label?: string;
  /** Additional allowed labels (e.g. ["security-override"]). */
  labels?: string[];
  /** Allowed user roles or permission levels: e.g. ["admin", "maintainer", "write", "security"]. */
  allowedRoles?: string[];
  /** Allowed specific GitHub logins: e.g. ["octocat", "sec-lead"]. */
  allowedUsers?: string[];
  /** Duration in minutes before the override expires. Defaults to 120 (2 hours). */
  expiresInMinutes?: number;
  /** Whether pushing new commits automatically revokes the override. Defaults to true. */
  revokeOnNewCommits?: boolean;
  /** Whether a reason comment is strictly required. Defaults to true. */
  requireReason?: boolean;
}

export interface OverrideEvaluationContext {
  /** PR labels present on the pull request. */
  labels: string[];
  /** Comments or review comments on the pull request. */
  comments?: Array<{
    author: string;
    body: string;
    createdAt: string | Date;
    authorAssociation?: string;
  }>;
  /** Details about the event or user who applied the label (if available from webhook). */
  sender?: {
    login: string;
    role?: string;
  };
  /** Commit SHA of the PR head currently being evaluated. */
  currentHeadSha: string;
  /** Commit SHA at the time the override was granted/recorded (if known). */
  overrideHeadSha?: string;
  /** Time the override label was added or granted. */
  overrideCreatedAt?: string | Date;
  /** Optional function to check if a user has sufficient repo role/permission. */
  hasPermission?: (user: string, roles: string[]) => Promise<boolean> | boolean;
}

export interface OverrideEvaluationResult {
  isOverridden: boolean;
  status:
    | "ACTIVE"
    | "EXPIRED"
    | "REVOKED_NEW_COMMITS"
    | "UNAUTHORIZED"
    | "MISSING_REASON"
    | "NO_OVERRIDE";
  reason?: string;
  actor?: string;
  appliedAt?: Date;
  expiresAt?: Date;
  notice?: string;
}

/**
 * Checks if any of the PR labels matches the configured override labels.
 */
export function hasOverrideLabel(prLabels: string[], config: BreakglassConfig): boolean {
  const targetLabel = (config.label || DEFAULT_OVERRIDE_LABEL).toLowerCase().trim();
  const allowedLabels = new Set([
    targetLabel,
    ...(config.labels || []).map((l) => l.toLowerCase().trim()),
  ]);

  return prLabels.some((l) => allowedLabels.has(l.toLowerCase().trim()));
}

/**
 * Checks whether an actor is authorized to apply an override.
 */
export function isActorAuthorized(
  actorLogin: string,
  actorRole: string | undefined,
  config: BreakglassConfig,
  authorAssociation?: string,
): boolean {
  const cleanLogin = actorLogin.toLowerCase().trim();

  // 1. Direct username check
  if (config.allowedUsers && config.allowedUsers.length > 0) {
    const userSet = new Set(config.allowedUsers.map((u) => u.toLowerCase().trim()));
    if (userSet.has(cleanLogin)) {
      return true;
    }
  }

  // 2. Role / association check
  const allowedRoles =
    config.allowedRoles && config.allowedRoles.length > 0
      ? config.allowedRoles.map((r) => r.toLowerCase().trim())
      : ["admin", "maintainer", "owner"]; // Safe default allowed roles

  const roleToCheck = (actorRole || authorAssociation || "").toLowerCase().trim();

  for (const role of allowedRoles) {
    if (role === "admin" && (roleToCheck === "admin" || roleToCheck === "owner")) return true;
    if (
      role === "maintainer" &&
      (roleToCheck === "maintainer" || roleToCheck === "admin" || roleToCheck === "owner")
    )
      return true;
    if (
      role === "write" &&
      (roleToCheck === "write" ||
        roleToCheck === "collaborator" ||
        roleToCheck === "member" ||
        roleToCheck === "admin" ||
        roleToCheck === "owner")
    )
      return true;
    if (roleToCheck === role) return true;
  }

  return false;
}

/**
 * Finds the override justification comment from the PR comment history.
 * Looks for comments matching patterns like:
 * "override: <reason>" or "/override <reason>" or "reason: <reason>"
 * or any comment posted by the authorized actor around the override time.
 */
export function extractOverrideReason(
  comments: Array<{ author: string; body: string; createdAt: string | Date }> = [],
  authorizedActor?: string,
): { reason: string; author: string; createdAt: Date } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const text = c.body.trim();

    // Look for explicit reason directives
    const directiveMatch = text.match(/^(?:(?:\/|!)?override|reason)\s*[:\-]?\s*(.+)$/i);
    if (directiveMatch) {
      return {
        reason: directiveMatch[1].trim(),
        author: c.author,
        createdAt: new Date(c.createdAt),
      };
    }

    // If author matches the actor who applied the label and comment contains non-trivial reason
    if (authorizedActor && c.author.toLowerCase() === authorizedActor.toLowerCase()) {
      if (text.length >= 5 && !text.startsWith("### 🛡️ SecureFlow")) {
        return {
          reason: text,
          author: c.author,
          createdAt: new Date(c.createdAt),
        };
      }
    }
  }

  return null;
}

/**
 * Evaluates whether a PR has a valid, active break-glass override (#2094).
 */
export function evaluateBreakglassOverride(
  context: OverrideEvaluationContext,
  config: BreakglassConfig = {},
): OverrideEvaluationResult {
  // Check if override label is present on PR
  if (!hasOverrideLabel(context.labels, config)) {
    return { isOverridden: false, status: "NO_OVERRIDE" };
  }

  const actorLogin = context.sender?.login || "";
  const actorRole = context.sender?.role;

  // Find relevant comment and actor
  const reasonEntry = extractOverrideReason(context.comments, actorLogin);
  const effectiveActor = actorLogin || reasonEntry?.author || "";

  // Check authorization
  const isAuthorized = isActorAuthorized(
    effectiveActor,
    actorRole,
    config,
    context.comments?.find((c) => c.author.toLowerCase() === effectiveActor.toLowerCase())
      ?.authorAssociation,
  );

  if (!isAuthorized) {
    return {
      isOverridden: false,
      status: "UNAUTHORIZED",
      actor: effectiveActor,
      notice: `Break-glass override label is present, but user '${effectiveActor}' is not authorized to override security policies.`,
    };
  }

  // Check required reason
  const requireReason = config.requireReason !== false;
  if (requireReason && (!reasonEntry || !reasonEntry.reason.trim())) {
    return {
      isOverridden: false,
      status: "MISSING_REASON",
      actor: effectiveActor,
      notice:
        "Break-glass override label is present, but no override reason comment was provided. Please post a comment explaining the reason for the override.",
    };
  }

  // Check commit revocation
  const revokeOnNewCommits = config.revokeOnNewCommits !== false;
  if (
    revokeOnNewCommits &&
    context.overrideHeadSha &&
    context.currentHeadSha &&
    context.overrideHeadSha !== context.currentHeadSha
  ) {
    return {
      isOverridden: false,
      status: "REVOKED_NEW_COMMITS",
      actor: effectiveActor,
      notice: `Break-glass override was revoked because new commits were pushed (${context.overrideHeadSha.slice(0, 7)} -> ${context.currentHeadSha.slice(0, 7)}).`,
    };
  }

  // Check expiration
  const expiryMinutes = config.expiresInMinutes ?? DEFAULT_OVERRIDE_EXPIRY_MINUTES;
  const appliedAt = context.overrideCreatedAt
    ? new Date(context.overrideCreatedAt)
    : reasonEntry?.createdAt || new Date();
  const expiresAt = new Date(appliedAt.getTime() + expiryMinutes * 60 * 1000);
  const now = new Date();

  if (now.getTime() > expiresAt.getTime()) {
    return {
      isOverridden: false,
      status: "EXPIRED",
      actor: effectiveActor,
      appliedAt,
      expiresAt,
      notice: `Break-glass override expired at ${expiresAt.toISOString()} (allowed duration: ${expiryMinutes}m).`,
    };
  }

  const finalReason = reasonEntry?.reason || "Emergency release override";

  return {
    isOverridden: true,
    status: "ACTIVE",
    actor: effectiveActor,
    reason: finalReason,
    appliedAt,
    expiresAt,
    notice: `⚠️ Security Gate Overridden by @${effectiveActor}: "${finalReason}" (Expires: ${expiresAt.toISOString()})`,
  };
}

/**
 * Records the override event in the audit log table.
 */
export async function recordOverrideAuditLog(params: {
  repositoryId?: string;
  repositoryFullName: string;
  prNumber: number;
  actor: string;
  reason: string;
  headSha: string;
  expiresAt: Date;
}): Promise<void> {
  try {
    if (prisma?.auditLog?.create) {
      await prisma.auditLog.create({
        data: {
          action: "BREAKGLASS_OVERRIDE",
          resource: `${params.repositoryFullName}#${params.prNumber}`,
          decision: "OVERRIDDEN",
          metadata: {
            actor: params.actor,
            reason: params.reason,
            headSha: params.headSha,
            expiresAt: params.expiresAt.toISOString(),
            timestamp: new Date().toISOString(),
          },
        },
      });
    }
  } catch (error) {
    console.error("[Breakglass] Failed to record audit log for override:", error);
  }
}
