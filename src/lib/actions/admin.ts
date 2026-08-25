"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { createLogger } from "@/lib/logger";
import {
  MAX_PAGE_SIZE,
  USERS_FETCH_ALL_LIMIT,
  actionsFromGroups,
  buildAuditLogWhere,
  buildUserWhere,
  collectActorIds,
  resolvePagination,
  totalPagesFor,
} from "@/lib/admin/queries";
import {
  invalidateCachedActions,
  readCachedActions,
  writeCachedActions,
} from "@/lib/admin/audit-filter-cache";

const log = createLogger({ context: { component: "admin-actions" } });

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

/**
 * Every user, for the client-side user-management table.
 *
 * Previously this asked for `pageSize: 10_000` against a clamp of 200 and
 * silently received 200 rows — no error, no truncation flag, no way for the
 * caller to know it had been given a fraction of the table. It now pages
 * through in full-size batches up to `USERS_FETCH_ALL_LIMIT` and says so when
 * it stops early, so the page can show "N of M" rather than quietly presenting
 * a prefix as the whole set.
 */
export async function getUsers(): Promise<AdminUserRow[]> {
  const { users } = await getAllUsers();
  return users;
}

export interface AllUsersResult {
  users: AdminUserRow[];
  /** Total matching rows in the database, which may exceed `users.length`. */
  total: number;
  /** True when the hard limit stopped the walk before the table was drained. */
  truncated: boolean;
}

export async function getAllUsers(): Promise<AllUsersResult> {
  const collected: AdminUserRow[] = [];
  let total = 0;
  let page = 1;

  while (collected.length < USERS_FETCH_ALL_LIMIT) {
    const result = await getUsersPage({ page, pageSize: MAX_PAGE_SIZE });
    total = result.total;
    collected.push(...result.users);

    if (result.users.length < MAX_PAGE_SIZE || page >= result.totalPages) break;
    page += 1;
  }

  const truncated = collected.length < total;
  if (truncated) {
    log.warn("User list truncated by the fetch-all ceiling", {
      returned: collected.length,
      total,
      limit: USERS_FETCH_ALL_LIMIT,
    });
  }

  return { users: collected.slice(0, USERS_FETCH_ALL_LIMIT), total, truncated };
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

  const { page, pageSize, skip, take } = resolvePagination(query);
  const where = buildUserWhere(query);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        roles: { include: { role: true } },
        _count: { select: { repositories: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
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
    totalPages: totalPagesFor(total, pageSize),
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
    data: sanitizeAuditLogInput({
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
    }),
  });

  // Both admin write paths append to AuditLog, and either can introduce an
  // action name the dropdown has not seen. Dropping the cache here is cheaper
  // and more correct than shortening the TTL for everyone.
  invalidateCachedActions();

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
    data: sanitizeAuditLogInput({
      userId: actorId,
      action: "ADMIN_USER_DELETE",
      resource: `user:${userId}`,
      decision: "DELETED",
      metadata: {
        targetEmail: target.email,
        targetCodename: target.codename,
      },
    }),
  });

  invalidateCachedActions();

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

/**
 * One page of audit logs, with each row's actor attached.
 *
 * The actor lookup is the part that mattered here (#645). It used to be:
 *
 *     prisma.user.findMany({ select: { id, name, email, codename } })
 *
 * with no `where` and no `take` — every row in the `User` table, four columns
 * of PII each, fetched on every render of `/admin/logs` so that at most 25 of
 * them could be matched to a log row. At ten thousand users that is ten
 * thousand rows crossing the wire to look up a couple of dozen.
 *
 * It is now scoped to the ids actually present on the page, and skipped
 * entirely when the page has no attributable rows. The cost is a function of
 * what is on screen rather than of how many users have ever signed up.
 *
 * The two log queries still run in parallel; the actor query cannot, because it
 * needs the ids the first one returns. That is one extra round trip in exchange
 * for a bounded one, which is the right trade at any table size worth caring
 * about.
 */
export async function getAuditLogs(query: AuditLogQuery = {}): Promise<AuditLogResult> {
  await requireAdmin();

  const { page, pageSize, skip, take } = resolvePagination(query);
  const where = buildAuditLogWhere(query);

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip,
      take,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const actorIds = collectActorIds(logs as Array<{ userId?: string | null }>);

  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true, codename: true },
      })
    : [];

  const userMap = new Map(actors.map((u: any) => [u.id, u]));

  return {
    logs: logs.map((l: any) => ({
      ...l,
      actor: l.userId ? ((userMap.get(l.userId) as AuditLogActor) ?? null) : null,
    })),
    total,
    page,
    pageSize,
    totalPages: totalPagesFor(total, pageSize),
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

/**
 * The distinct action names, for the filter dropdown.
 *
 * `findMany({ distinct: ['action'] })` reads like `SELECT DISTINCT`. It is not:
 * Prisma applies `distinct` in the query engine *after* the rows come back, and
 * there was no `take`, so this read every `AuditLog` row's `action` column into
 * memory and deduped it in JavaScript — on the fastest-growing table in the
 * schema, on every render of the page an operator opens when something is
 * already wrong.
 *
 * `groupBy` is the same answer as one aggregate in Postgres. The result is then
 * held for a minute, because the set of distinct actions changes a handful of
 * times over the life of the application and the write paths that can add one
 * invalidate it explicitly.
 */
export async function getAuditLogFilters(): Promise<{ actions: string[] }> {
  await requireAdmin();

  const cachedActions = readCachedActions();
  if (cachedActions) return { actions: cachedActions };

  const groups = await prisma.auditLog.groupBy({
    by: ["action"],
    orderBy: { action: "asc" },
  });

  const actions = actionsFromGroups(groups as Array<{ action?: string | null }>);
  writeCachedActions(actions);

  return { actions };
}
