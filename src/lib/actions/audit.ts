"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";

/**
 * Shared guard for the dashboard's audit log actions. Returns the signed-in
 * user's id. Throws "Unauthorized" if there is no session — mirrors the
 * requireAdmin() guard in lib/actions/admin.ts, but scoped to "any signed-in
 * user" rather than "ADMIN only", since this powers the per-user dashboard
 * view rather than the admin portal.
 */
async function requireUser(): Promise<string> {
  const session = await auth();

  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  return session.user.id;
}

export interface UserAuditLogRow {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  decision: string | null;
  metadata: any;
  timestamp: Date;
}

export interface UserAuditLogResult {
  logs: UserAuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UserAuditLogQuery {
  action?: string;
  decision?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Fetches the signed-in user's audit logs with optional filtering — same
 * shape as getAuditLogs() in lib/actions/admin.ts (action/search + paginated
 * result), but always scoped to the caller's own userId so one user can
 * never see another user's audit trail.
 */
export async function getUserAuditLogs(
  query: UserAuditLogQuery = {}
): Promise<UserAuditLogResult> {
  const userId = await requireUser();

  const { action, decision, search } = query;
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));

  const where: any = { userId };
  if (action) where.action = action;
  if (decision) where.decision = decision;
  if (search) {
    where.OR = [
      { action: { contains: search, mode: "insensitive" } },
      { resource: { contains: search, mode: "insensitive" } },
      { decision: { contains: search, mode: "insensitive" } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Distinct action/decision values for the signed-in user's own audit logs,
 * used to populate the filter dropdowns — equivalent to getAuditLogFilters()
 * in lib/actions/admin.ts, scoped down to just this user's data.
 */
export async function getUserAuditLogFilters(): Promise<{
  actions: string[];
  decisions: string[];
}> {
  const userId = await requireUser();

  const [actionRows, decisionRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: { userId },
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { userId, decision: { not: null } },
      distinct: ["decision"],
      select: { decision: true },
      orderBy: { decision: "asc" },
    }),
  ]);

  return {
    actions: actionRows.map((r: any) => r.action),
    decisions: decisionRows.map((r: any) => r.decision as string),
  };
}