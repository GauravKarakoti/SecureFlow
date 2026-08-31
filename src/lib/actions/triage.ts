"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { invalidateCachedUserFilters } from "@/lib/audit/user-filter-cache";
import {
  isTriageStatus,
  type TriageStatus as SharedTriageStatus,
} from "@/lib/triage/statuses";

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

/**
 * Set the triage status (+ optional note) for a finding, keyed by its stable
 * fingerprint so the decision survives the re-scans that recreate Finding rows.
 *
 * Mirrors the `"use server"` + `revalidatePath` pattern used by the policies
 * page, and writes one AuditLog entry per change like the rest of the app.
 */
export async function setFindingStatus(
  input: SetFindingStatusInput
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

export interface BulkTriageTarget {
  repositoryId: string;
  fingerprint: string;
}

export interface SetFindingStatusBulkInput {
  targets: BulkTriageTarget[];
  status: TriageStatus;
  note?: string | null;
}

export interface SetFindingStatusBulkResult {
  ok: boolean;
  /** How many findings were triaged. */
  updated: number;
  error?: string;
}

/** Ceiling on findings triaged in a single bulk call, matching the page-size cap. */
export const MAX_BULK_TRIAGE = 100;

/**
 * Apply a triage status (+ optional note) to many findings at once (#732).
 *
 * A thin fan-out over the same upsert `setFindingStatus` performs: bulk triage
 * is a convenience for the reviewer, not a second code path, so it reuses the
 * ownership check, the audit log entry and the revalidation rather than
 * reimplementing them. The only additions are a per-call cap and a
 * per-repository ownership lookup that is done once rather than per finding.
 */
export async function setFindingStatusBulk(
  input: SetFindingStatusBulkInput
): Promise<SetFindingStatusBulkResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, updated: 0, error: "Not authenticated" };
  }
  const userId = session.user.id;

  const { status } = input;
  const note = input.note?.trim() ? input.note.trim() : null;

  if (!isTriageStatus(status)) {
    return { ok: false, updated: 0, error: "Invalid status" };
  }

  const targets = (input.targets ?? []).filter(
    (t) => t && t.repositoryId && t.fingerprint
  );
  if (targets.length === 0) {
    return { ok: false, updated: 0, error: "No findings selected" };
  }
  if (targets.length > MAX_BULK_TRIAGE) {
    return {
      ok: false,
      updated: 0,
      error: `Cannot triage more than ${MAX_BULK_TRIAGE} findings at once`,
    };
  }

  // Resolve — and authorise — every distinct repository once, so a request that
  // names a repository the user does not own is rejected before any write.
  const repoIds = [...new Set(targets.map((t) => t.repositoryId))];
  const repos = await prisma.repository.findMany({
    where: { id: { in: repoIds }, userId },
    select: { id: true, fullName: true },
  });
  const ownedRepos = new Map(
    repos.map((r: { id: string; fullName: string }) => [r.id, r.fullName])
  );
  if (ownedRepos.size !== repoIds.length) {
    return { ok: false, updated: 0, error: "Repository not found" };
  }

  await prisma.$transaction(
    targets.flatMap(({ repositoryId, fingerprint }) => [
      prisma.findingTriage.upsert({
        where: { repositoryId_fingerprint: { repositoryId, fingerprint } },
        update: { status, note, resolvedById: userId },
        create: { repositoryId, fingerprint, status, note, resolvedById: userId },
      }),
      prisma.auditLog.create({
        data: sanitizeAuditLogInput({
          userId,
          action: "Finding Triage",
          resource: `${ownedRepos.get(repositoryId)}:${fingerprint.slice(0, 12)}`,
          decision: status,
          metadata: { repositoryId, fingerprint, status, hasNote: note !== null, bulk: true },
        }),
      }),
    ])
  );

  invalidateCachedUserFilters(userId);

  revalidatePath("/dashboard/findings");
  revalidatePath("/dashboard");

  return { ok: true, updated: targets.length };
}
