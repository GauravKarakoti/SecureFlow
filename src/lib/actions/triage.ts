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
  note?: string | null;
  expiresAt?: Date | string | null;
}

export interface SetFindingStatusResult {
  ok: boolean;
  error?: string;
}

export interface FindingTriageTarget {
  repositoryId: string;
  fingerprint: string;
}

export interface SetFindingStatusesInput {
  items: FindingTriageTarget[];
  status: TriageStatus;
  reason?: DismissalReason | string | null;
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

  // Dismissal validation: dismissing requires a non-empty note/reason
  let dismissalReason: DismissalReason | null = null;
  let dismissedAt: Date | null = null;
  let dismissedById: string | null = null;

  if (status === "DISMISSED" || status === "FALSE_POSITIVE" || status === "IGNORED") {
    if (status === "DISMISSED") {
      if (!note) {
        return { ok: false, error: "A note or explanation is required when dismissing a finding" };
      }
      if (input.reason && !isDismissalReason(input.reason)) {
        return { ok: false, error: "Invalid dismissal reason category" };
      }
      dismissalReason = (input.reason as DismissalReason) ?? "FALSE_POSITIVE";
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

  return { ok: true };
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
    if (!note) {
      return { ok: false, error: "A note or explanation is required when dismissing a finding" };
    }
    if (input.reason && !isDismissalReason(input.reason)) {
      return { ok: false, error: "Invalid dismissal reason category" };
    }
    dismissalReason = (input.reason as DismissalReason) ?? "FALSE_POSITIVE";
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

  if (repos.length !== repoIds.length) {
    return { ok: false, error: "Repository not found" };
  }

  const repoName = new Map<string, string>(
    repos.map((repo: { id: string; fullName: string }) => [repo.id, repo.fullName]),
  );

  await prisma.$transaction(async (tx: TriageTransactionClient) => {
    for (const item of items) {
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

  return { ok: true };
}
