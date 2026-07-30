"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";

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
  startDate?: Date;
  endDate?: Date;
}

function buildUserAuditLogWhere(
  userId: string,
  query: Pick<UserAuditLogQuery, "action" | "decision" | "search" | "startDate" | "endDate">
) {
  console.log("DEBUG buildUserAuditLogWhere called with:", query);
  const { action, decision, search, startDate, endDate } = query;

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
  if (startDate || endDate) {
    where.timestamp = {};
    if (startDate) where.timestamp.gte = startDate;
    if (endDate) where.timestamp.lte = endDate;
  }

  console.log("DEBUG final where clause:", JSON.stringify(where));
  return where;
}

export async function getUserAuditLogs(
  query: UserAuditLogQuery = {}
): Promise<UserAuditLogResult> {
  const userId = await requireUser();

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
  const where = buildUserAuditLogWhere(userId, query);

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

const MAX_EXPORT_ROWS = 5000;

export async function getUserAuditLogsForExport(
  query: Pick<UserAuditLogQuery, "action" | "decision" | "search" | "startDate" | "endDate"> = {}
): Promise<UserAuditLogRow[]> {
  const userId = await requireUser();
  const where = buildUserAuditLogWhere(userId, query);

  return prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: MAX_EXPORT_ROWS,
  });
}

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