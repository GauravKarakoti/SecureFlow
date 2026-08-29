"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import {
  readCachedUserFilters,
  valuesFromGroups,
  writeCachedUserFilters,
  type UserAuditFilters,
} from "@/lib/audit/user-filter-cache";
import {
  MAX_EXPORT_ROWS,
  summarizeExport,
  type UserAuditLogExport,
  type UserAuditLogRow,
} from "@/lib/audit/export-limits";

async function requireUser(): Promise<string> {
  const session = await auth();

  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  return session.user.id;
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

  // Was two console.log("DEBUG ...") statements printing this clause -- and with
  // it `query.search`, the raw string the user typed into the filter box -- to
  // stdout on every page load, unbounded and with no LOG_LEVEL to turn it off
  // (#563). Kept at debug level, where it is off by default in production.
  logger.debug("Built audit log filter", {
    userId,
    hasSearch: Boolean(search),
    action: action ?? null,
    decision: decision ?? null,
  });

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

/**
 * Rows for the CSV export, plus whether the cap truncated them.
 *
 * The cap itself is right — an export should not be able to pull an unbounded
 * table into memory. The problem was returning a bare array, so the caller
 * could not tell "you have 4,000 rows, here are all of them" from "you have
 * 40,000, here are the newest 5,000". `audit-log-table.tsx` took the array
 * straight to `downloadCSV`, and the user got a file that looked complete and
 * was not — the worst failure mode for a screen whose entire purpose is
 * producing an audit trail (#659).
 *
 * The shape mirrors `getUserAuditLogs`, which already returns its total. The
 * cap and the arithmetic that builds that shape live in
 * `@/lib/audit/export-limits`, because this module is `"use server"` and may
 * only export async functions.
 */
export async function getUserAuditLogsForExport(
  query: Pick<UserAuditLogQuery, "action" | "decision" | "search" | "startDate" | "endDate"> = {}
): Promise<UserAuditLogExport> {
  const userId = await requireUser();
  const where = buildUserAuditLogWhere(userId, query);

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: MAX_EXPORT_ROWS,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return summarizeExport(rows as UserAuditLogRow[], total, MAX_EXPORT_ROWS);
}

/**
 * The distinct action and decision values this user has produced, for the
 * filter dropdowns.
 *
 * This was two `findMany({ distinct })` calls with no `take` — the shape #645
 * replaced on `/admin/logs`, with the comment above `getAuditLogFilters`
 * explaining why. Scoped to one user it is not a whole-table scan, but it is
 * still unbounded in the dimension that grows: `AuditLog` is the fastest-growing
 * table in the schema, every scan and triage decision adds a row, and nothing
 * prunes per user. To produce a dozen strings it read every audit row the user
 * has ever generated — on every render of `/dashboard/audit`, and again on
 * every filter and page change, because `page.tsx` runs it in the same
 * `Promise.all` as the first ten log rows.
 *
 * `groupBy` is one aggregate per column in Postgres, and the result is held for
 * a minute, because the set of values a user produces changes a handful of
 * times over the life of the account and the write paths invalidate it.
 */
export async function getUserAuditLogFilters(): Promise<UserAuditFilters> {
  const userId = await requireUser();

  const cached = readCachedUserFilters(userId);
  if (cached) return cached;

  const [actionGroups, decisionGroups] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ["action"],
      where: { userId },
      orderBy: { action: "asc" },
    }),
    prisma.auditLog.groupBy({
      by: ["decision"],
      where: { userId, decision: { not: null } },
      orderBy: { decision: "asc" },
    }),
  ]);

  const filters: UserAuditFilters = {
    actions: valuesFromGroups(actionGroups as Array<Record<string, unknown>>, "action"),
    decisions: valuesFromGroups(decisionGroups as Array<Record<string, unknown>>, "decision"),
  };

  writeCachedUserFilters(userId, filters);

  return filters;
}