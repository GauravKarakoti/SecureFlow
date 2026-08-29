"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { invalidateCachedUserFilters } from "@/lib/audit/user-filter-cache";
import { isTriageStatus, type TriageStatus as SharedTriageStatus } from "@/lib/triage/statuses";

// The lifecycle a finding can move through. OPEN is the implicit default (no
// triage row); the other three suppress the finding from the dashboard tiles,
// and FALSE_POSITIVE / IGNORED additionally stop it BLOCKing the PR on re-scan.
//
// The list itself lives in @/lib/triage/statuses — this was the fourth
// hand-written copy of the same strings (#689). Re-exported here because the
// triage UI imports the type from this module.
export type TriageStatus = SharedTriageStatus;

export interface SetFindingStatusInput {
  repositoryId: string;
  fingerprint: string;
  status: TriageStatus;
  note?: string | null;
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
  note?: string | null;
}

/** Cap matches the findings list page-size ceiling so one page cannot overflow this. */
export const MAX_BULK_TRIAGE = 100;

/**
 * Set the triage status (+ optional note) for a finding, keyed by its stable
 * fingerprint so the decision survives the re-scans that recreate Finding rows.
 *
 * Mirrors the `"use server"` + `revalidatePath` pattern used by the policies
 * page, and writes one AuditLog entry per change like the rest of the app.
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
    update: { status, note, resolvedById: userId },
    create: { repositoryId, fingerprint, status, note, resolvedById: userId },
  });

  await prisma.auditLog.create({
    data: sanitizeAuditLogInput({
      userId,
      action: "Finding Triage",
      resource: `${repo.fullName}:${fingerprint.slice(0, 12)}`,
      decision: status,
      metadata: { repositoryId, fingerprint, status, hasNote: note !== null },
    }),
  });

  // A triage decision can introduce an action or decision value this user's
  // filter dropdowns have not seen. Dropping their cached list here is cheaper
  // and more correct than shortening the TTL for everyone (#659) — the same
  // reasoning as invalidateCachedActions() on the admin side.
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
 *
 * Ownership is checked once for every distinct repository. Writes and audit
 * rows happen in a single transaction so a partial page update cannot land.
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
  const { status } = input;
  const repoIds = [...new Set(items.map((item) => item.repositoryId))];

  const repos = await prisma.repository.findMany({
    where: { id: { in: repoIds }, userId },
    select: { id: true, fullName: true },
  });
  if (repos.length !== repoIds.length) {
    return { ok: false, error: "Repository not found" };
  }

  const repoName = new Map(repos.map((repo) => [repo.id, repo.fullName]));

  await prisma.$transaction(async (tx) => {
    for (const item of items) {
      await tx.findingTriage.upsert({
        where: {
          repositoryId_fingerprint: {
            repositoryId: item.repositoryId,
            fingerprint: item.fingerprint,
          },
        },
        update: { status, note, resolvedById: userId },
        create: {
          repositoryId: item.repositoryId,
          fingerprint: item.fingerprint,
          status,
          note,
          resolvedById: userId,
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
            hasNote: note !== null,
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
