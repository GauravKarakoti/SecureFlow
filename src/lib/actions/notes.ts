"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { notifyMentionedUsers } from "@/lib/actions/notifications";

export interface FindingNoteAuthor {
  id: string;
  name: string | null;
  email: string | null;
  codename: string | null;
  image: string | null;
}

export interface FindingNoteDto {
  id: string;
  findingId: string;
  authorId: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
  author: FindingNoteAuthor;
}

export const MAX_NOTE_LENGTH = 1000;

interface AuthUser {
  id: string;
  roles?: string[];
}

async function requireSession(): Promise<AuthUser> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }
  return {
    id: session.user.id,
    roles: session.user.roles,
  };
}

/**
 * Checks whether the given user has access to the finding via repository ownership or ADMIN role.
 */
async function getFindingWithRepoAccess(findingId: string, user: AuthUser) {
  const finding = await prisma.finding.findUnique({
    where: { id: findingId },
    include: {
      scanResult: {
        include: {
          pullRequest: {
            include: { repository: true },
          },
        },
      },
    },
  });

  if (!finding) {
    return null;
  }

  const repo = finding.scanResult.pullRequest.repository;
  const isAdmin = user.roles?.includes("ADMIN") ?? false;
  const hasAccess = isAdmin || repo.userId === user.id;

  return { finding, repo, hasAccess, isAdmin };
}

/**
 * Fetch all reviewer notes for a finding, ordered chronologically.
 */
export async function getFindingNotes(findingId: string): Promise<FindingNoteDto[]> {
  const user = await requireSession();
  const access = await getFindingWithRepoAccess(findingId, user);

  if (!access) {
    throw new Error("Finding not found");
  }
  if (!access.hasAccess) {
    throw new Error("Forbidden: You do not have access to this repository");
  }

  const notes = await prisma.findingNote.findMany({
    where: { findingId },
    orderBy: { createdAt: "asc" },
    include: {
      author: {
        select: {
          id: true,
          name: true,
          email: true,
          codename: true,
          image: true,
        },
      },
    },
  });

  return notes as FindingNoteDto[];
}

/**
 * Add a context note to a finding. Validates length (<= 1,000 chars) and repo access.
 * Records the action in the audit log.
 */
export async function addFindingNote(
  findingId: string,
  text: string,
): Promise<{ ok: boolean; note?: FindingNoteDto; error?: string }> {
  const user = await requireSession();

  if (typeof text !== "string") {
    return { ok: false, error: "Note text must be a string" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Note cannot be empty" };
  }

  if (trimmed.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `Note must be at most ${MAX_NOTE_LENGTH.toLocaleString()} characters`,
    };
  }

  const access = await getFindingWithRepoAccess(findingId, user);
  if (!access) {
    return { ok: false, error: "Finding not found" };
  }
  if (!access.hasAccess) {
    return { ok: false, error: "Forbidden: You do not have access to this repository" };
  }

  const note = await prisma.findingNote.create({
    data: {
      findingId,
      authorId: user.id,
      text: trimmed,
    },
    include: {
      author: {
        select: {
          id: true,
          name: true,
          email: true,
          codename: true,
          image: true,
        },
      },
    },
  });

  await prisma.auditLog.create({
    data: sanitizeAuditLogInput({
      userId: user.id,
      action: "FINDING_NOTE_CREATE",
      resource: `finding:${findingId}`,
      decision: "CREATED",
      metadata: {
        findingId,
        noteId: note.id,
        authorId: user.id,
        length: note.text.length,
        repositoryId: access.repo.id,
      },
    }),
  });

  // Notify any @mentioned repository members (#1979)
  try {
    await notifyMentionedUsers({
      text: trimmed,
      findingId,
      repositoryId: access.repo.id,
      authorId: user.id,
      authorName: note.author?.name || note.author?.codename || note.author?.email,
      repoFullName: access.repo.fullName,
    });
  } catch (notifErr) {
    console.error("Failed to notify mentioned users:", notifErr);
  }

  revalidatePath(`/dashboard/findings/${findingId}`);
  revalidatePath("/dashboard/findings");

  return { ok: true, note: note as FindingNoteDto };
}

/**
 * Delete a reviewer note. Only the note's author or an administrator may delete it.
 * Records the deletion in the audit log.
 */
export async function deleteFindingNote(noteId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireSession();

  const note = await prisma.findingNote.findUnique({
    where: { id: noteId },
    include: {
      finding: {
        include: {
          scanResult: {
            include: {
              pullRequest: {
                include: { repository: true },
              },
            },
          },
        },
      },
    },
  });

  if (!note) {
    return { ok: false, error: "Note not found" };
  }

  const repo = note.finding.scanResult.pullRequest.repository;
  const isAdmin = user.roles?.includes("ADMIN") ?? false;
  const hasRepoAccess = isAdmin || repo.userId === user.id;

  if (!hasRepoAccess) {
    return { ok: false, error: "Forbidden: You do not have access to this repository" };
  }

  const isAuthor = note.authorId === user.id;
  if (!isAuthor && !isAdmin) {
    return {
      ok: false,
      error: "Forbidden: Only the author or an administrator can delete this note",
    };
  }

  await prisma.findingNote.delete({
    where: { id: noteId },
  });

  await prisma.auditLog.create({
    data: sanitizeAuditLogInput({
      userId: user.id,
      action: "FINDING_NOTE_DELETE",
      resource: `finding:${note.findingId}`,
      decision: "DELETED",
      metadata: {
        findingId: note.findingId,
        noteId: note.id,
        authorId: note.authorId,
        deletedBy: user.id,
        isAuthor,
        isAdmin,
        repositoryId: repo.id,
      },
    }),
  });

  revalidatePath(`/dashboard/findings/${note.findingId}`);
  revalidatePath("/dashboard/findings");

  return { ok: true };
}
