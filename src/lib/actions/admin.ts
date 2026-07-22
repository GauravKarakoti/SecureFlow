"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

/**
 * Shared admin guard. Returns the authenticated admin session.
 * Throws "Unauthorized" if the caller is not signed in or not an ADMIN.
 */
async function requireAdmin() {
  const session = await auth();

  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  return session as any;
}

// ─── Existing: Admin dashboard metrics ────────────────────────────────────────
export async function getAdminMetrics() {
  await requireAdmin();

  const [totalUsers, totalPrs, totalAudits] = await Promise.all([
    prisma.user.count(),
    prisma.pullRequest.count(),
    prisma.auditLog.count(),
  ]);

  return { totalUsers, totalPrs, totalAudits };
}

// ─── Existing: Recent audit logs (admin dashboard widget) ─────────────────────
export async function getRecentAuditLogs() {
  await requireAdmin();

  return await prisma.auditLog.findMany({
    orderBy: { timestamp: "desc" },
    take: 100,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  USER MANAGEMENT  —  powers /admin/users
// ═══════════════════════════════════════════════════════════════════════════════

export interface AdminUserRow {
  id: string;
  name: string | null;
  email: string | null;
  codename: string | null;
  image: string | null;
  roles: string[];
  repoCount: number;
  createdAt: Date;
}

export async function getUsers(): Promise<AdminUserRow[]> {
  const result = await getUsersPage({ page: 1, pageSize: 10_000 });
  return result.users;
}

export interface UsersResult {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UsersQuery {
  search?: string;
  role?: "ADMIN" | "USER" | "ALL";
  page?: number;
  pageSize?: number;
}

export async function getUsersPage(query: UsersQuery = {}): Promise<UsersResult> {
  await requireAdmin();

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));

  const { search, role } = query;

  const where: any = {};

  if (search) {
    const q = search.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { codename: { contains: q, mode: "insensitive" } },
      ];
    }
  }

  if (role && role !== "ALL") {
    where.roles = {
      some: {
        role: { name: role },
      },
    };
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        roles: { include: { role: true } },
        _count: { select: { repositories: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: users.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      codename: u.codename,
      image: u.image,
      roles: u.roles.map((r: any) => r.role.name),
      repoCount: u._count.repositories,
      createdAt: u.createdAt,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  };
}

export interface UserManagementMetrics {
  total: number;
  admins: number;
  standard: number;
  last24h: number;
}

export async function getUserManagementMetrics(): Promise<UserManagementMetrics> {
  await requireAdmin();

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, admins, standard, last24h] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { roles: { some: { role: { name: "ADMIN" } } } } }),
    prisma.user.count({ where: { roles: { some: { role: { name: "USER" } } } } }),
    prisma.user.count({ where: { createdAt: { gte: yesterday } } }),
  ]);

  return { total, admins, standard, last24h };
}

export type RoleName = "ADMIN" | "USER";

/**
 * Replaces a user's role set with a single new role.
 * Safety: cannot remove own ADMIN role; cannot demote the last ADMIN.
 * Every change is recorded in the AuditLog.
 */
export async function updateUserRole(userId: string, newRole: RoleName) {
  const session = await requireAdmin();
  const actorId = session.user.id;

  if (userId === actorId && newRole !== "ADMIN") {
    throw new Error("You cannot remove your own admin role.");
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } },
  });

  if (!target) {
    throw new Error("User not found.");
  }

  const oldRoles = target.roles.map((r: any) => r.role.name);

  if (oldRoles.length === 1 && oldRoles[0] === newRole) {
    return { success: true, unchanged: true };
  }

  if (newRole !== "ADMIN" && oldRoles.includes("ADMIN")) {
    const adminCount = await prisma.user.count({
      where: { roles: { some: { role: { name: "ADMIN" } } } },
    });
    if (adminCount <= 1) {
      throw new Error("Cannot demote the last remaining administrator.");
    }
  }

  const role = await prisma.role.upsert({
    where: { name: newRole },
    update: {},
    create: { name: newRole, description: `${newRole} access` },
  });

  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId } }),
    prisma.userRole.create({ data: { userId, roleId: role.id } }),
  ]);

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: "ADMIN_ROLE_UPDATE",
      resource: `user:${userId}`,
      decision: newRole,
      metadata: {
        targetEmail: target.email,
        targetCodename: target.codename,
        oldRoles,
        newRole,
      },
    },
  });

  revalidatePath("/admin/users");
  revalidatePath("/admin");
  revalidatePath("/admin/logs");

  return { success: true };
}

/**
 * Permanently deletes a user (cascades to repositories, PRs, scans, etc.).
 * Safety: cannot delete self; cannot delete the last ADMIN.
 */
export async function deleteUser(userId: string) {
  const session = await requireAdmin();
  const actorId = session.user.id;

  if (userId === actorId) {
    throw new Error("You cannot delete your own account.");
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } },
  });

  if (!target) {
    throw new Error("User not found.");
  }

  if (target.roles.some((r: any) => r.role.name === "ADMIN")) {
    const adminCount = await prisma.user.count({
      where: { roles: { some: { role: { name: "ADMIN" } } } },
    });
    if (adminCount <= 1) {
      throw new Error("Cannot delete the last remaining administrator.");
    }
  }

  await prisma.user.delete({ where: { id: userId } });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: "ADMIN_USER_DELETE",
      resource: `user:${userId}`,
      decision: "DELETED",
      metadata: {
        targetEmail: target.email,
        targetCodename: target.codename,
      },
    },
  });

  revalidatePath("/admin/users");
  revalidatePath("/admin");
  revalidatePath("/admin/logs");

  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUDIT LOGS  —  powers /admin/logs
// ═══════════════════════════════════════════════════════════════════════════════

export interface AuditLogActor {
  id: string;
  name: string | null;
  email: string | null;
  codename: string | null;
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  decision: string | null;
  metadata: any;
  timestamp: Date;
  actor: AuditLogActor | null;
}

export interface AuditLogResult {
  logs: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AuditLogQuery {
  action?: string;
  userId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function getAuditLogs(query: AuditLogQuery = {}): Promise<AuditLogResult> {
  await requireAdmin();

  const { action, userId, search } = query;
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));

  const where: any = {};
  if (action) where.action = action;
  if (userId) where.userId = userId;
  if (search) {
    where.OR = [
      { action: { contains: search, mode: "insensitive" } },
      { resource: { contains: search, mode: "insensitive" } },
      { decision: { contains: search, mode: "insensitive" } },
    ];
  }

  const [logs, total, users] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({
      select: { id: true, name: true, email: true, codename: true },
    }),
  ]);

  const userMap = new Map(users.map((u: any) => [u.id, u]));

  return {
    logs: logs.map((l: any) => ({
      ...l,
      actor: l.userId ? ((userMap.get(l.userId) as AuditLogActor) ?? null) : null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  };
}

export interface AuditLogMetrics {
  total: number;
  last24h: number;
  topActions: { action: string; count: number }[];
}

export async function getAuditLogMetrics(): Promise<AuditLogMetrics> {
  await requireAdmin();

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, last24h, grouped] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.count({ where: { timestamp: { gte: yesterday } } }),
    prisma.auditLog.groupBy({
      by: ["action"],
      _count: true,
      orderBy: { _count: { action: "desc" } },
      take: 6,
    }),
  ]);

  return {
    total,
    last24h,
    topActions: grouped.map((g: any) => ({ action: g.action, count: g._count })),
  };
}

export async function getAuditLogFilters(): Promise<{ actions: string[] }> {
  await requireAdmin();

  const rows = await prisma.auditLog.findMany({
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });

  return { actions: rows.map((r: any) => r.action) };
}
