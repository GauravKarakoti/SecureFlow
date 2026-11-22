"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { hasAdminRole } from "@/lib/admin/role-guard";

export interface AssignableUser {
  id: string;
  name: string | null;
  email: string | null;
  codename: string | null;
  image: string | null;
}

export interface AssignFindingInput {
  repositoryId: string;
  fingerprint: string;
  assigneeId: string | null;
}

export interface AssignFindingResult {
  ok: boolean;
  error?: string;
  assigneeId?: string | null;
}

/**
 * Checks whether a user has access to a specific repository.
 *
 * A user has access if:
 * 1. The repository exists and is active.
 * 2. AND either:
 *    - The user is the owner/installer of the repository (repo.userId === userId).
 *    - OR the user holds an administrative role in the system.
 */
export async function checkUserRepoAccess(
  userId: string,
  repositoryId: string,
): Promise<boolean> {
  if (!userId || !repositoryId) return false;

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, userId: true, isActive: true },
  });

  if (!repo || !repo.isActive) {
    return false;
  }

  if (repo.userId === userId) {
    return true;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      roles: {
        select: {
          role: { select: { name: true } },
        },
      },
    },
  });

  if (!user) return false;

  const roleNames = user.roles.map((r: any) => r.role.name);
  return hasAdminRole(roleNames);
}

/**
 * Retrieve all users eligible to be assigned findings in a given repository.
 */
export async function getAssignableUsers(repositoryId: string): Promise<AssignableUser[]> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const callerHasAccess = await checkUserRepoAccess(session.user.id, repositoryId);
  if (!callerHasAccess) {
    throw new Error("Repository not found or access denied");
  }

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      userId: true,
      user: {
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

  if (!repo) return [];

  // Admins also have access to all repositories
  const admins = await prisma.user.findMany({
    where: {
      roles: {
        some: {
          role: { name: "ADMIN" },
        },
      },
    },
    select: {
      id: true,
      name: true,
      email: true,
      codename: true,
      image: true,
    },
  });

  const userMap = new Map<string, AssignableUser>();
  if (repo.user) {
    userMap.set(repo.user.id, repo.user);
  }
  for (const admin of admins) {
    userMap.set(admin.id, admin);
  }

  return Array.from(userMap.values());
}

/**
 * Assign or unassign a finding to a user.
 *
 * Rules:
 * - Caller must be authenticated and have access to the repository.
 * - If assigneeId is provided, the target assignee must have access to the repository.
 * - Updates FindingTriage record.
 * - Writes an audit log entry for the assignment change.
 */
export async function assignFinding(input: AssignFindingInput): Promise<AssignFindingResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Not authenticated" };
  }
  const actorId = session.user.id;

  const { repositoryId, fingerprint, assigneeId } = input;
  if (!repositoryId || !fingerprint) {
    return { ok: false, error: "Missing required finding parameters" };
  }

  // Verify caller repository access
  const callerHasAccess = await checkUserRepoAccess(actorId, repositoryId);
  if (!callerHasAccess) {
    return { ok: false, error: "You do not have access to this repository" };
  }

  // If assigning to a user, verify the target user has repository access
  let targetUser: { id: string; email: string | null; name: string | null } | null = null;
  if (assigneeId) {
    const targetHasAccess = await checkUserRepoAccess(assigneeId, repositoryId);
    if (!targetHasAccess) {
      return { ok: false, error: "Assignee does not have access to this repository" };
    }

    targetUser = await prisma.user.findUnique({
      where: { id: assigneeId },
      select: { id: true, email: true, name: true },
    });
    if (!targetUser) {
      return { ok: false, error: "Target user not found" };
    }
  }

  // Upsert the triage record
  await prisma.findingTriage.upsert({
    where: {
      repositoryId_fingerprint: {
        repositoryId,
        fingerprint,
      },
    },
    update: {
      assigneeId: assigneeId ?? null,
    },
    create: {
      repositoryId,
      fingerprint,
      assigneeId: assigneeId ?? null,
      status: "OPEN",
    },
  });

  // Record assignment change in AuditLog
  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId: actorId,
        action: "FINDING_ASSIGN",
        resource: `repository:${repositoryId}:finding:${fingerprint}`,
        decision: assigneeId ? "ASSIGNED" : "UNASSIGNED",
        metadata: {
          repositoryId,
          fingerprint,
          assigneeId: assigneeId ?? null,
          assigneeName: targetUser?.name ?? null,
          assigneeEmail: targetUser?.email ?? null,
          assignedById: actorId,
        },
      }),
    });
  } catch (err) {
    console.error("Failed to create audit log for assignment:", err);
  }

  revalidatePath("/dashboard/findings");
  revalidatePath(`/dashboard/findings/[id]`);

  return { ok: true, assigneeId: assigneeId ?? null };
}

/**
 * Automatically unassign findings when assignees no longer have access to the repository.
 * Returns the count of unassigned findings.
 */
export async function unassignInaccessibleFindings(
  repositoryId?: string,
): Promise<{ unassignedCount: number }> {
  const whereClause: any = {
    assigneeId: { not: null },
  };
  if (repositoryId) {
    whereClause.repositoryId = repositoryId;
  }

  const assignedTriages = await prisma.findingTriage.findMany({
    where: whereClause,
    select: {
      id: true,
      repositoryId: true,
      fingerprint: true,
      assigneeId: true,
    },
  });

  let unassignedCount = 0;

  for (const triage of assignedTriages) {
    if (!triage.assigneeId) continue;

    const hasAccess = await checkUserRepoAccess(triage.assigneeId, triage.repositoryId);
    if (!hasAccess) {
      await prisma.findingTriage.update({
        where: { id: triage.id },
        data: { assigneeId: null },
      });

      try {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId: triage.assigneeId,
            action: "FINDING_UNASSIGN_ACCESS_LOSS",
            resource: `repository:${triage.repositoryId}:finding:${triage.fingerprint}`,
            decision: "UNASSIGNED",
            metadata: {
              repositoryId: triage.repositoryId,
              fingerprint: triage.fingerprint,
              previousAssigneeId: triage.assigneeId,
              reason: "ACCESS_LOSS",
            },
          }),
        });
      } catch (err) {
        console.error("Failed to create audit log for access-loss unassignment:", err);
      }

      unassignedCount++;
    }
  }

  if (unassignedCount > 0) {
    revalidatePath("/dashboard/findings");
  }

  return { unassignedCount };
}

/**
 * Explicit handler for when a specific user loses access to a repository.
 */
export async function onUserAccessLoss(
  userId: string,
  repositoryId: string,
): Promise<{ unassignedCount: number }> {
  const assigned = await prisma.findingTriage.findMany({
    where: {
      repositoryId,
      assigneeId: userId,
    },
    select: {
      id: true,
      repositoryId: true,
      fingerprint: true,
      assigneeId: true,
    },
  });

  if (assigned.length === 0) {
    return { unassignedCount: 0 };
  }

  await prisma.findingTriage.updateMany({
    where: {
      repositoryId,
      assigneeId: userId,
    },
    data: {
      assigneeId: null,
    },
  });

  for (const item of assigned) {
    try {
      await prisma.auditLog.create({
        data: sanitizeAuditLogInput({
          userId,
          action: "FINDING_UNASSIGN_ACCESS_LOSS",
          resource: `repository:${repositoryId}:finding:${item.fingerprint}`,
          decision: "UNASSIGNED",
          metadata: {
            repositoryId,
            fingerprint: item.fingerprint,
            previousAssigneeId: userId,
            reason: "ACCESS_LOSS",
          },
        }),
      });
    } catch (err) {
      console.error("Failed to write audit log for access loss:", err);
    }
  }

  revalidatePath("/dashboard/findings");
  return { unassignedCount: assigned.length };
}
