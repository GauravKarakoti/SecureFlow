"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { invalidateCachedUserFilters } from "@/lib/audit/user-filter-cache";
import {
  MAX_BULK_TRIAGE,
  isTriageStatus,
  isDismissalReason,
  type TriageStatus as SharedTriageStatus,
  type DismissalReason,
} from "@/lib/triage/statuses";
import { validateExpiryDate } from "@/lib/triage/expiry";
import { reconcileTriageVerdicts } from "@/lib/triage/reconcile";
import {
  dispatchOutboundWebhooksForUser,
  buildFindingDismissedPayload,
} from "@/lib/webhooks/outbound-dispatcher";
import { can } from "@/lib/auth/permissions";

export type TriageStatus = SharedTriageStatus;
export type { DismissalReason };

interface TriageTransactionClient {
  findingTriage: { upsert: (args: unknown) => Promise<unknown> };
  auditLog: { create: (args: unknown) => Promise<unknown> };
}

export interface SetFindingStatusInput {
  repositoryId: string;
  fingerprint: string;
  status: TriageStatus;
  reason?: DismissalReason | string | null;
  category?: DismissalReason | string | null;
  note?: string | null;
  expiresAt?: Date | string | null;
}

export interface SetFindingStatusResult {
  ok: boolean;
  error?: string;
  warning?: string;
  updatedCount?: number;
  skippedCount?: number;
}

export interface FindingTriageTarget {
  repositoryId: string;
  fingerprint: string;
}

export interface SetFindingStatusesInput {
  items: FindingTriageTarget[];
  status: TriageStatus;
  reason?: DismissalReason | string | null;
  category?: DismissalReason | string | null;
  note?: string | null;
  expiresAt?: Date | string | null;
}

/**
 * Set the triage status (+ optional reason + required/optional note + optional expiry) for a finding,
 * keyed by its stable fingerprint so the decision survives the re-scans that recreate Finding rows.
 */
export async function setFindingStatus(
  input: SetFindingStatusInput,
): Promise<SetFindingStatusResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Not authenticated" };
  }
  const userId = session.user.id;

  const { repositoryId, fingerprint, status } = input;
  const note = input.note?.trim() ? input.note.trim() : null;

  if (!repositoryId || !fingerprint) {
    return { ok: false, error: "Missing finding reference" };
  }
  if (!isTriageStatus(status)) {
    return { ok: false, error: "Invalid status" };
  }

  const isDismissing =
    status === "DISMISSED" || status === "FALSE_POSITIVE" || status === "IGNORED";
  const requiredAction = isDismissing ? "findings:dismiss" : "findings:restore";
  if (!can(session.user, repositoryId, requiredAction)) {
    return { ok: false, error: "Permission denied: your role does not allow triaging findings" };
  }

  // A category is required; the explanatory note is optional (#2096).
  let dismissalReason: DismissalReason | null = null;
  let dismissedAt: Date | null = null;
  let dismissedById: string | null = null;

  if (status === "DISMISSED" || status === "FALSE_POSITIVE" || status === "IGNORED") {
    if (status === "DISMISSED") {
      const category = input.category || input.reason;
      if (!category) {
        return { ok: false, error: "Dismissal reason category is required" };
      }
      if (!isDismissalReason(category)) {
        return { ok: false, error: "Invalid dismissal reason category" };
      }
      dismissalReason = category;
      dismissedAt = new Date();
      dismissedById = userId;
    }
  }

  // Handle optional dismissal expiry: ignore for OPEN and RESOLVED.
  let expiresAt: Date | null = null;
  if (status === "FALSE_POSITIVE" || status === "IGNORED" || status === "DISMISSED") {
    const validated = validateExpiryDate(input.expiresAt, new Date());
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    expiresAt = validated.expiresAt;
  }

  // Only let a user triage findings in a repository they own.
  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
    select: { id: true, fullName: true },
  });
  if (!repo) {
    return { ok: false, error: "Repository not found" };
  }

  await prisma.findingTriage.upsert({
    where: { repositoryId_fingerprint: { repositoryId, fingerprint } },
    update: {
      status,
      note,
      resolvedById: userId,
      expiresAt,
      dismissalReason,
      dismissedAt,
      dismissedById,
    },
    create: {
      repositoryId,
      fingerprint,
      status,
      note,
      resolvedById: userId,
      expiresAt,
      dismissalReason,
      dismissedAt,
      dismissedById,
    },
  });

  await prisma.auditLog.create({
    data: sanitizeAuditLogInput({
      userId,
      action: "Finding Triage",
      resource: `${repo.fullName}:${fingerprint.slice(0, 12)}`,
      decision: status,
      metadata: {
        repositoryId,
        fingerprint,
        status,
        dismissalReason,
        hasNote: note !== null,
        note,
        dismissedAt: dismissedAt?.toISOString() ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    }),
  });

  invalidateCachedUserFilters(userId);
  revalidatePath("/dashboard/findings");
  revalidatePath("/dashboard");

  if (status === "DISMISSED") {
    try {
      await dispatchOutboundWebhooksForUser(userId, "finding.dismissed", () =>
        buildFindingDismissedPayload({
          repository: repo.fullName,
          fingerprint,
          status,
          reason: dismissalReason,
          dismissedAt: dismissedAt?.toISOString() ?? new Date().toISOString(),
        }),
      );
    } catch (whErr) {
      console.error("[Triage] Failed to dispatch outbound webhook for finding.dismissed:", whErr);
    }
  }

  let warning: string | undefined;
  try {
    const result = await reconcileTriageVerdicts(repositoryId, [fingerprint]);
    if (result.pending > 0)
      warning = "Saved. The affected PR needs a new scan before its verdict updates.";
  } catch {
    warning = "Saved. The affected PR verdict will update after the next scan.";
  }

  return { ok: true, ...(warning ? { warning } : {}) };
}

function normalizeTriageTargets(items: FindingTriageTarget[] | undefined): FindingTriageTarget[] {
  const seen = new Set<string>();
  const normalized: FindingTriageTarget[] = [];

  for (const item of items ?? []) {
    if (!item?.repositoryId || !item?.fingerprint) continue;
    const key = `${item.repositoryId}:${item.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ repositoryId: item.repositoryId, fingerprint: item.fingerprint });
  }

  return normalized;
}

/**
 * Apply one triage status to many findings on the current page.
 */
export async function setFindingStatuses(
  input: SetFindingStatusesInput,
): Promise<SetFindingStatusResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Not authenticated" };
  }
  const userId = session.user.id;

  if (!isTriageStatus(input.status)) {
    return { ok: false, error: "Invalid status" };
  }

  const isDismissing =
    input.status === "DISMISSED" || input.status === "FALSE_POSITIVE" || input.status === "IGNORED";
  const requiredAction = isDismissing ? "findings:dismiss" : "findings:restore";
  if (!can(session.user, null, requiredAction)) {
    return {
      ok: false,
      error: "Permission denied: your role does not allow triaging findings",
    };
  }

  const items = normalizeTriageTargets(input.items);
  if (items.length === 0) {
    return { ok: false, error: "No findings selected" };
  }
  if (items.length > MAX_BULK_TRIAGE) {
    return { ok: false, error: "Too many findings" };
  }

  const note = input.note?.trim() ? input.note.trim() : null;

  let dismissalReason: DismissalReason | null = null;
  let dismissedAt: Date | null = null;
  let dismissedById: string | null = null;

  if (input.status === "DISMISSED") {
    const category = input.category || input.reason;
    if (!category) {
      return { ok: false, error: "Dismissal reason category is required" };
    }
    if (!isDismissalReason(category)) {
      return { ok: false, error: "Invalid dismissal reason category" };
    }
    dismissalReason = category;
    dismissedAt = new Date();
    dismissedById = userId;
  }

  let expiresAt: Date | null = null;
  if (
    input.status === "FALSE_POSITIVE" ||
    input.status === "IGNORED" ||
    input.status === "DISMISSED"
  ) {
    const validated = validateExpiryDate(input.expiresAt, new Date());
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    expiresAt = validated.expiresAt;
  }

  const { status } = input;
  const repoIds = [...new Set(items.map((item) => item.repositoryId))];

  const repos = await prisma.repository.findMany({
    where: { id: { in: repoIds }, userId },
    select: { id: true, fullName: true },
  });

  const accessibleRepoIds = new Set<string>(
    repos.map((repo: { id: string; fullName: string }) => repo.id),
  );
  const accessibleItems = items.filter((item) => accessibleRepoIds.has(item.repositoryId));
  const skippedCount = items.length - accessibleItems.length;

  if (accessibleItems.length === 0) {
    return {
      ok: false,
      error: "Repository not found",
      skippedCount: items.length,
      updatedCount: 0,
    };
  }

  const repoName = new Map<string, string>(
    repos.map((repo: { id: string; fullName: string }) => [repo.id, repo.fullName]),
  );

  await prisma.$transaction(async (tx: TriageTransactionClient) => {
    for (const item of accessibleItems) {
      await tx.findingTriage.upsert({
        where: {
          repositoryId_fingerprint: {
            repositoryId: item.repositoryId,
            fingerprint: item.fingerprint,
          },
        },
        update: {
          status,
          note,
          resolvedById: userId,
          expiresAt,
          dismissalReason,
          dismissedAt,
          dismissedById,
        },
        create: {
          repositoryId: item.repositoryId,
          fingerprint: item.fingerprint,
          status,
          note,
          resolvedById: userId,
          expiresAt,
          dismissalReason,
          dismissedAt,
          dismissedById,
        },
      });

      await tx.auditLog.create({
        data: sanitizeAuditLogInput({
          userId,
          action: "Finding Triage",
          resource: `${repoName.get(item.repositoryId)}:${item.fingerprint.slice(0, 12)}`,
          decision: status,
          metadata: {
            repositoryId: item.repositoryId,
            fingerprint: item.fingerprint,
            status,
            dismissalReason,
            hasNote: note !== null,
            note,
            dismissedAt: dismissedAt?.toISOString() ?? null,
            expiresAt: expiresAt?.toISOString() ?? null,
            bulk: true,
          },
        }),
      });
    }
  });

  invalidateCachedUserFilters(userId);
  revalidatePath("/dashboard/findings");
  revalidatePath("/dashboard");

  if (status === "DISMISSED") {
    const repoMap = new Map<string, string>(
      (repos as any[]).map((r: any) => [String(r.id), String(r.fullName)]),
    );
    for (const item of accessibleItems) {
      const repoFullName = repoMap.get(item.repositoryId) || "unknown";
      try {
        await dispatchOutboundWebhooksForUser(userId, "finding.dismissed", () =>
          buildFindingDismissedPayload({
            repository: repoFullName,
            fingerprint: String(item.fingerprint),
            status: String(status),
            reason: dismissalReason,
            dismissedAt: dismissedAt?.toISOString() ?? new Date().toISOString(),
          }),
        );
      } catch (whErr) {
        console.error("[Triage] Failed to dispatch outbound webhook for finding.dismissed:", whErr);
      }
    }
  }

  let warning: string | undefined;
  if (skippedCount > 0) {
    warning = `Updated ${accessibleItems.length} finding(s). Skipped ${skippedCount} finding(s) in repositories you cannot access.`;
  }

  const accessibleRepoIdsList = [...accessibleRepoIds];
  for (const repositoryId of accessibleRepoIdsList) {
    try {
      const changed = accessibleItems.filter((item) => item.repositoryId === repositoryId);
      const result = await reconcileTriageVerdicts(
        repositoryId,
        changed.map((item) => item.fingerprint),
      );
      if (result.pending > 0 && !warning) {
        warning = "Saved. Some PRs need a new scan before their verdict updates.";
      }
    } catch {
      if (!warning) {
        warning = "Saved. Some PR verdicts will update after the next scan.";
      }
    }
  }

  return {
    ok: true,
    updatedCount: accessibleItems.length,
    skippedCount,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Migration helper to migrate existing dismissals with null or missing dismissalReason
 * to the 'UNSPECIFIED' category (#2096).
 */
export async function migrateUnspecifiedDismissals(): Promise<{ updatedCount: number }> {
  try {
    const result = await prisma.findingTriage.updateMany({
      where: {
        status: { in: ["DISMISSED", "FALSE_POSITIVE", "IGNORED"] },
        dismissalReason: null,
      },
      data: {
        dismissalReason: "UNSPECIFIED",
      },
    });

    return { updatedCount: result.count };
  } catch (error) {
    console.error("[Triage] Failed to migrate unspecified dismissals:", error);
    return { updatedCount: 0 };
  }
}
