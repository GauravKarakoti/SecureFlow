"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { assertCan, can, getUserRole, type InstallationRole } from "@/lib/auth/permissions";
import {
  ADMIN_ROLE,
  DEMOTE_LAST_ADMIN_MESSAGE,
  assertAdminsRemain,
  isNoOpRoleChange,
  isSelfDemotion,
  isUniqueConstraintError,
  removesAdminRole,
  type RoleName,
} from "@/lib/admin/role-guard";
import { invalidateCachedActions } from "@/lib/admin/audit-filter-cache";

const ADMIN_COUNT_WHERE = {
  roles: { some: { role: { name: ADMIN_ROLE } } },
};

export interface InstallationMemberRow {
  id: string;
  name: string | null;
  email: string | null;
  codename: string | null;
  image: string | null;
  role: InstallationRole;
  roles: string[];
  repoCount: number;
  createdAt: Date;
}

/**
 * Resolves or creates a Role row by name.
 */
async function resolveRole(tx: any, name: string) {
  try {
    return await tx.role.upsert({
      where: { name },
      update: {},
      create: { name, description: `${name} access` },
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const existing = await tx.role.findUnique({ where: { name } });
    if (!existing) throw err;
    return existing;
  }
}

/**
 * Fetches all members of the installation/organization with their assigned role.
 */
export async function getInstallationMembers(): Promise<InstallationMemberRow[]> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      roles: {
        include: { role: true },
      },
      repositories: {
        select: { id: true },
      },
    },
  });

  return users.map((u: any) => {
    const roles = u.roles.map((r: any) => r.role.name);
    const role = getUserRole({ id: u.id, roles });

    return {
      id: u.id,
      name: u.name,
      email: u.email,
      codename: u.codename,
      image: u.image,
      role,
      roles,
      repoCount: u.repositories.length,
      createdAt: u.createdAt,
    };
  });
}

/**
 * Updates an installation member's role (VIEWER, TRIAGER, ADMIN).
 *
 * Rules:
 * - Only ADMINs can change member roles.
 * - Cannot remove own ADMIN role (self-demotion blocked).
 * - Cannot demote the last remaining ADMIN.
 * - Every change is recorded in AuditLog.
 */
export async function updateMemberRole(targetUserId: string, newRole: RoleName) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized: Sign in required");
  }

  // Only admins can make role changes
  assertCan(session.user, null, "members:manage");
  const actorId = session.user.id;

  if (isSelfDemotion(actorId, targetUserId, newRole)) {
    throw new Error("You cannot remove your own admin role.");
  }

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roles: { include: { role: true } } },
  });

  if (!target) {
    throw new Error("User not found.");
  }

  const oldRoles: string[] = target.roles.map((r: any) => r.role.name);

  if (isNoOpRoleChange(oldRoles, newRole)) {
    return { success: true, unchanged: true };
  }

  // Fast pre-check before transaction
  if (removesAdminRole(oldRoles, newRole)) {
    const adminCount = await prisma.user.count({ where: ADMIN_COUNT_WHERE });
    assertAdminsRemain(adminCount - 1, DEMOTE_LAST_ADMIN_MESSAGE);
  }

  await prisma.$transaction(async (tx: any) => {
    const roleRecord = await resolveRole(tx, newRole);

    await tx.userRole.deleteMany({ where: { userId: targetUserId } });
    await tx.userRole.create({
      data: { userId: targetUserId, roleId: roleRecord.id },
    });

    // Post-check invariant inside transaction
    const remainingAdmins = await tx.user.count({ where: ADMIN_COUNT_WHERE });
    assertAdminsRemain(remainingAdmins, DEMOTE_LAST_ADMIN_MESSAGE);

    // Audit log entry for role change
    await tx.auditLog.create({
      data: sanitizeAuditLogInput({
        userId: actorId,
        action: "MEMBER_ROLE_UPDATE",
        resource: `user:${targetUserId}`,
        decision: newRole,
        metadata: {
          targetUserId,
          targetEmail: target.email,
          targetCodename: target.codename,
          oldRoles,
          newRole,
        },
      }),
    });
  });

  invalidateCachedActions();

  revalidatePath("/dashboard/members");
  revalidatePath("/admin/users");
  revalidatePath("/admin");

  return { success: true };
}
