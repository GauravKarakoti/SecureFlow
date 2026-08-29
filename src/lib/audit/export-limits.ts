/**
 * Bounds and result shaping for the `/dashboard/audit` CSV export (#659).
 *
 * This lives beside `user-filter-cache.ts` rather than in
 * `src/lib/actions/audit.ts` for the same reason that file gives: `audit.ts` is
 * a `"use server"` module, and the only thing a `"use server"` module may
 * export is an async function. A `export const MAX_EXPORT_ROWS = 5000` there
 * type-checks and passes tests, because `tsc` and Vitest both read the file as
 * ordinary TypeScript — but the React Server Components bundler rewrites every
 * export of a `"use server"` module into a server-reference stub, so at runtime
 * the importer receives a callable stub where it expected the number `5000`.
 * Anything the constant feeds -- `take:`, the `truncated` comparison, the
 * "showing the newest N" copy -- then reads `undefined`, and Prisma's `take`
 * silently becomes unbounded, which is exactly the failure the cap exists to
 * prevent.
 *
 * So the cap and the arithmetic around it are plain module scope, and
 * `audit.ts` imports them.
 */

/**
 * The most rows a single CSV export will read.
 *
 * An export must not be able to pull an unbounded table into memory: `AuditLog`
 * is the fastest-growing table in the schema and nothing prunes it per user.
 * Five thousand rows is a ~1 MB CSV, comfortably openable in a spreadsheet, and
 * well inside a serverless function's memory budget.
 */
export const MAX_EXPORT_ROWS = 5000;

/** A single audit row as the export returns it. */
export interface UserAuditLogRow {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  decision: string | null;
  metadata: unknown;
  timestamp: Date;
}

export interface UserAuditLogExport {
  rows: UserAuditLogRow[];
  /** Rows matching the filters, which may exceed `rows.length`. */
  total: number;
  /** True when `MAX_EXPORT_ROWS` stopped the read before the match was drained. */
  truncated: boolean;
  /** The cap that was applied, so the caller does not have to hardcode it. */
  limit: number;
}

/**
 * Pair a page of rows with the total that matched, and say whether the cap cut
 * them short.
 *
 * The comparison is `total > rows.length` rather than `rows.length === limit`
 * so that a match of exactly `limit` rows is reported as complete, which it is.
 * Reporting it as truncated would put a "your export is incomplete" warning on
 * a file that contains every row the filter selected.
 *
 * `total` is clamped up to `rows.length` because the count and the read are two
 * queries: rows written between them can produce a `total` lower than the page
 * just read, and a negative "N more rows" is worse than a slightly stale count.
 */
export function summarizeExport(
  rows: UserAuditLogRow[],
  total: number,
  limit: number = MAX_EXPORT_ROWS
): UserAuditLogExport {
  const safeTotal = Math.max(total, rows.length);

  return {
    rows,
    total: safeTotal,
    truncated: safeTotal > rows.length,
    limit,
  };
}

/**
 * How many matching rows the export left behind, for the warning copy.
 *
 * Never negative, so the caller can interpolate it directly.
 */
export function omittedRowCount(summary: UserAuditLogExport): number {
  return Math.max(0, summary.total - summary.rows.length);
}
