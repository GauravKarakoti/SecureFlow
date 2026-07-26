"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

// The lifecycle a finding can move through. OPEN is the implicit default (no
// triage row); the other three suppress the finding from the dashboard tiles,
// and FALSE_POSITIVE / IGNORED additionally stop it BLOCKing the PR on re-scan.
export const TRIAGE_STATUSES = ["OPEN", "RESOLVED", "FALSE_POSITIVE", "IGNORED"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

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
  if (!TRIAGE_STATUSES.includes(status)) {
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
    data: {
      userId,
      action: "Finding Triage",
      resource: `${repo.fullName}:${fingerprint.slice(0, 12)}`,
      decision: status,
      metadata: { repositoryId, fingerprint, status, hasNote: note !== null },
    },
  });

  revalidatePath("/dashboard/findings");
  revalidatePath("/dashboard");

  return { ok: true };
}
