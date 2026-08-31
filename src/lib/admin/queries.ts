/**
 * Query shapes and paging maths for the admin pages (#645).
 *
 * These used to be inline in `src/lib/actions/admin.ts`, which is a
 * `"use server"` module: every export there has to be an async server action, so
 * nothing in it can be unit-tested without going through the action boundary and
 * a Prisma mock. Pulling the pure parts out means the paging clamps, the filter
 * shapes and — most importantly — the *scoping* of the actor lookup can be
 * asserted directly.
 *
 * The bug this exists to prevent: `getAuditLogs` fetched **every row in the
 * `User` table** on every render, unfiltered and untaken, to attach actors to at
 * most 25 log rows. `collectActorIds` is what makes the replacement query
 * bounded, and it has a test that fails if the scoping is ever dropped again.
 */

/** Rows per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 25;

/** Largest page a caller may request. */
export const MAX_PAGE_SIZE = 200;

/**
 * Ceiling on the "give me everything" path used by the user-management table.
 *
 * `getUsers()` previously asked for `pageSize: 10_000` against a clamp of 200
 * and silently got 200 back, with no error and no truncation flag — the caller
 * could not tell it had been lied to. It now pages up to this bound and reports
 * whether it stopped early.
 */
export const USERS_FETCH_ALL_LIMIT = 5_000;

export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

export interface ResolvedPagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/**
 * Clamp a page request into something safe to hand Prisma.
 *
 * A page below 1 becomes 1 and a page size outside `[1, MAX_PAGE_SIZE]` is
 * clamped rather than rejected: an admin who types `?page=0` should get the
 * first page, not an error.
 */
export function resolvePagination(
  input: PaginationInput = {},
  maxPageSize: number = MAX_PAGE_SIZE
): ResolvedPagination {
  // `|| fallback` would be wrong here: it also swallows a legitimate 0, which
  // must clamp up to 1 rather than reset to the default. NaN is the only value
  // that needs the fallback.
  const rawPage = Math.floor(input.page ?? 1);
  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);

  const rawSize = Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE);
  const requested = Number.isFinite(rawSize) ? rawSize : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(maxPageSize, Math.max(1, requested));

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Total pages for a result count, never below 1 so the UI has something to show. */
export function totalPagesFor(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export interface AuditLogFilters {
  action?: string;
  userId?: string;
  search?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Build the `where` for an audit-log query.
 *
 * A blank or whitespace-only `search` produces no `OR` clause at all. Leaving an
 * empty `contains` in place makes Postgres scan for a substring that matches
 * every row, which is a full-table scan dressed up as a filter.
 *
 * `startDate`/`endDate` mirror the dashboard's own audit-log filter
 * (`buildUserAuditLogWhere` in `lib/actions/audit.ts`): both are inclusive
 * bounds on `timestamp`, and either may be supplied on its own.
 */
export function buildAuditLogWhere(filters: AuditLogFilters = {}): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.action) where.action = filters.action;
  if (filters.userId) where.userId = filters.userId;

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { action: { contains: search, mode: 'insensitive' } },
      { resource: { contains: search, mode: 'insensitive' } },
      { decision: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (filters.startDate || filters.endDate) {
    const timestamp: Record<string, Date> = {};
    if (filters.startDate) timestamp.gte = filters.startDate;
    if (filters.endDate) timestamp.lte = filters.endDate;
    where.timestamp = timestamp;
  }

  return where;
}

export interface UserFilters {
  search?: string;
  role?: 'ADMIN' | 'USER' | 'ALL';
}

/** Build the `where` for a user query. Same empty-search rule as above. */
export function buildUserWhere(filters: UserFilters = {}): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { codename: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (filters.role && filters.role !== 'ALL') {
    where.roles = { some: { role: { name: filters.role } } };
  }

  return where;
}

/**
 * The distinct, non-null actor ids on a page of logs.
 *
 * This is the whole fix for the unbounded user read: at most `pageSize` ids,
 * usually far fewer, instead of every row in `User`. An empty result means the
 * page has no attributable rows and the actor query can be skipped entirely.
 */
export function collectActorIds(rows: Array<{ userId?: string | null }>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.userId) ids.add(row.userId);
  }
  return [...ids];
}

/**
 * Extract the distinct action names from a `groupBy` result.
 *
 * `findMany({ distinct: ['action'] })` looks like it does this in the database.
 * It does not: Prisma applies `distinct` in the query engine *after* the rows
 * come back, so with no `take` it reads every `AuditLog` row's `action` column
 * into memory to build a dropdown with a dozen entries. `groupBy` is the same
 * answer as one aggregate in Postgres.
 */
export function actionsFromGroups(groups: Array<{ action?: string | null }>): string[] {
  const actions = groups
    .map((group) => group.action)
    .filter((action): action is string => typeof action === 'string' && action.length > 0);

  return [...new Set(actions)].sort((a, b) => a.localeCompare(b));
}