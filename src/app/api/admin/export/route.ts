import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { streamCsv } from "@/lib/utils/csv-stream";

/** Column order of the export. Fixed rather than derived so the file shape is stable. */
export const AUDIT_LOG_EXPORT_COLUMNS = [
  "id",
  "userId",
  "action",
  "resource",
  "decision",
  "metadata",
  "timestamp",
] as const;

/**
 * Rows per database round trip.
 *
 * Small enough that peak memory is a batch rather than a table, large enough
 * that a 50k-row export is 100 queries and not 50,000.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * Ceiling on rows a single export may emit.
 *
 * The previous handler had no bound of any kind. A ceiling means the request
 * always terminates; it is stated in a response header rather than applied
 * silently, so a truncated download is visible as truncated.
 */
export const MAX_EXPORT_ROWS = 100_000;

/** Default window when the caller does not ask for one. */
export const DEFAULT_EXPORT_WINDOW_DAYS = 90;

/**
 * Parse an ISO-8601 date query parameter.
 *
 * Returns `undefined` for an absent or empty value and throws for a malformed
 * one. Silently ignoring a typo would hand back a different range than the
 * operator asked for, which for an audit export is worse than an error.
 */
export function parseDateParam(raw: string | null, name: string): Date | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid \`${name}\` parameter: expected an ISO-8601 date.`, 400);
  }

  return parsed;
}

/** Parse a positive integer, clamped to `max`. */
export function parseLimitParam(raw: string | null, max: number): number | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new AppError("Invalid `limit` parameter: expected a positive integer.", 400);
  }

  return Math.min(parsed, max);
}

export interface ExportRange {
  from?: Date;
  to?: Date;
  limit: number;
}

/**
 * Resolve the requested range.
 *
 * With no parameters the export covers the last `DEFAULT_EXPORT_WINDOW_DAYS`
 * rather than all of history. That is the change most likely to surprise
 * someone, so it is stated in the `X-Export-Window` response header and
 * overridable with `?from=1970-01-01`.
 */
export function resolveExportRange(
  searchParams: URLSearchParams,
  now: Date = new Date()
): ExportRange {
  const from = parseDateParam(searchParams.get("from"), "from");
  const to = parseDateParam(searchParams.get("to"), "to");
  const limit = parseLimitParam(searchParams.get("limit"), MAX_EXPORT_ROWS) ?? MAX_EXPORT_ROWS;

  if (from && to && from > to) {
    throw new AppError("Invalid range: `from` is after `to`.", 400);
  }

  if (!from && !to) {
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - DEFAULT_EXPORT_WINDOW_DAYS);
    return { from: defaultFrom, limit };
  }

  return { ...(from && { from }), ...(to && { to }), limit };
}

/** Keyset position. `timestamp` is not unique, so `id` breaks the tie. */
export interface ExportCursor {
  timestamp: Date;
  id: string;
}

/**
 * Build the `where` clause for one page.
 *
 * Keyset pagination rather than `skip`/`take`. An offset makes the database
 * count past every skipped row, so page N costs N × page size; and a row
 * written mid-export shifts the offset, which duplicates or drops a record. The
 * `(timestamp, id)` tuple comparison is stable under concurrent writes, which
 * for an audit log is not a nicety.
 */
export function buildExportWhere(range: ExportRange, cursor: ExportCursor | null) {
  const timestampRange = {
    ...(range.from && { gte: range.from }),
    ...(range.to && { lte: range.to }),
  };

  const rangeFilter = Object.keys(timestampRange).length > 0 ? { timestamp: timestampRange } : {};

  if (!cursor) return rangeFilter;

  // Ordering is `timestamp desc, id asc`, so "after the cursor" means an older
  // timestamp, or the same timestamp with a higher id.
  return {
    ...rangeFilter,
    OR: [
      { timestamp: { lt: cursor.timestamp } },
      { timestamp: cursor.timestamp, id: { gt: cursor.id } },
    ],
  };
}

/** Filename carrying the range, so two exports don't overwrite each other. */
export function exportFilename(range: ExportRange): string {
  const stamp = (date: Date | undefined) => (date ? date.toISOString().slice(0, 10) : "all");
  return `audit_logs_${stamp(range.from)}_to_${stamp(range.to)}.csv`;
}

/** Human-readable range for the `X-Export-Window` header. */
export function describeRange(range: ExportRange): string {
  return `${range.from ? range.from.toISOString() : "beginning"}..${
    range.to ? range.to.toISOString() : "now"
  }`;
}

async function handler(req: NextRequest) {
  const session = await auth();

  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new AppError("Unauthorized access", 401);
  }

  const range = resolveExportRange(req.nextUrl.searchParams);

  // Streamed rather than buffered. The previous handler read every AuditLog row
  // into the heap, built the whole document as one string, and handed that
  // string to NextResponse — roughly three simultaneous copies of the table, on
  // a function with a fixed memory budget, reachable by one GET (#592).
  //
  // An empty range now produces a header-only CSV. It used to 404: a fresh
  // install clicking Export got an error dialog for the correct and expected
  // state of "nothing has happened yet".
  const body = streamCsv<ExportCursor>(
    async (cursor, take) => {
      const rows = await prisma.auditLog.findMany({
        where: buildExportWhere(range, cursor),
        orderBy: [{ timestamp: "desc" }, { id: "asc" }],
        take,
      });

      const last = rows[rows.length - 1];

      return {
        rows: rows as Array<Record<string, unknown>>,
        nextCursor: last ? { timestamp: last.timestamp, id: last.id } : null,
      };
    },
    {
      headers: [...AUDIT_LOG_EXPORT_COLUMNS],
      batchSize: EXPORT_BATCH_SIZE,
      maxRows: range.limit,
    }
  );

  return new NextResponse(body, {
    status: 200,
    headers: {
      // The charset is explicit so the BOM is interpreted rather than shown as
      // stray characters in the first header cell.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(range)}"`,
      // Audit data must never be cached by an intermediary.
      "Cache-Control": "no-store",
      // The applied bounds, stated rather than silent, so a client can tell a
      // complete export from one that stopped at the ceiling.
      "X-Export-Limit": String(range.limit),
      "X-Export-Window": describeRange(range),
    },
  });
}

export const GET = withRateLimit(
  withErrorHandler(handler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "admin:export" }
);
