/**
 * Query construction for the Security Findings dashboard (#561).
 *
 * `src/app/dashboard/findings/page.tsx` used to inline a `findMany` with a
 * hard-coded `take: 50`, no `skip`, and no filters. Two things followed from
 * that, and both were bugs rather than missing features:
 *
 *  1. The three stat tiles were counted with `...notDismissed` while the list
 *     query was not, so a user who triaged everything away saw `0 / 0 / 0` in
 *     the tiles above a table of fifty dismissed rows, with the header badge
 *     reading "50 Findings" because it rendered `findings.length` — the page
 *     size, not a total.
 *  2. Dismissed findings still occupied slots in that fifty. A repository with
 *     one noisy rule could fill the whole visible window with FALSE_POSITIVEs,
 *     and marking them as false positives did not free the slots. There was no
 *     filter to hide them and no page 2 to escape to, so the rest of the
 *     findings were permanently unreachable.
 *
 * Everything here is pure and takes its inputs as arguments. The `"use server"`
 * action module cannot host these — a `"use server"` file may only export async
 * functions — and keeping them separate is what makes the clamping, the sort
 * mapping and the where-builder unit-testable without a database.
 *
 * The public shapes deliberately mirror `src/lib/actions/audit.ts`, which
 * already solved this problem for the audit log.
 */

import { SEVERITY_ORDER, isSeverity, type Severity } from '@/lib/severity';

/** Triage states a finding can be filtered by. Mirrors `TRIAGE_STATUSES`. */
export const FINDING_STATUSES = ['OPEN', 'RESOLVED', 'FALSE_POSITIVE', 'IGNORED'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * Statuses that hide a finding from the stat tiles.
 *
 * Kept identical to `SUPPRESSED_STATUSES` in `src/lib/triage/queries.ts`; the
 * test suite asserts the two agree, since they must or the tiles and the list
 * drift apart again.
 */
export const DISMISSED_STATUSES: readonly FindingStatus[] = ['FALSE_POSITIVE', 'IGNORED'];

/** Sort keys the UI exposes. */
export const FINDING_SORTS = ['newest', 'oldest', 'severity', 'file'] as const;
export type FindingSort = (typeof FINDING_SORTS)[number];

export const DEFAULT_SORT: FindingSort = 'newest';
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Hard ceiling on rows per request.
 *
 * A hand-edited `?pageSize=100000` would otherwise pull the entire findings
 * table — every code snippet and AI explanation the user owns — in one
 * response. Matches the cap `getUserAuditLogs` already applies.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * A raw, untrusted query.
 *
 * Nullable rather than merely optional so an already-normalized query can be
 * fed straight back in — `normalizeFindingsQuery` is idempotent, which is what
 * lets the page normalize once from `searchParams` and hand the result to the
 * server action without a second shape in between.
 */
export interface FindingsQuery {
  page?: number | null;
  pageSize?: number | null;
  severity?: string[] | null;
  type?: string[] | null;
  status?: string[] | null;
  repositoryId?: string | null;
  search?: string | null;
  sort?: string | null;
}

/** A query with every field resolved to a safe, in-range value. */
export interface NormalizedFindingsQuery {
  page: number;
  pageSize: number;
  severity: Severity[];
  type: string[];
  status: FindingStatus[];
  repositoryId: string | null;
  search: string | null;
  sort: FindingSort;
}

/** Longest search string worth sending to Postgres as an ILIKE pattern. */
const MAX_SEARCH_LENGTH = 200;

/** Cap on how many values a single multi-select filter may carry. */
const MAX_FILTER_VALUES = 20;

/**
 * Clamp a page number to `>= 1`.
 *
 * `?page=0` produces `skip: -20`, which Prisma rejects at runtime with an
 * unhelpful error, and `?page=-5` is worse. Non-numeric input falls back to
 * page 1 rather than to `NaN`, which would make `skip` `NaN` and silently
 * return nothing.
 */
export function clampPage(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
}

/** Clamp a page size into `1..MAX_PAGE_SIZE`, defaulting when unparseable. */
export function clampPageSize(value: unknown, fallback: number = DEFAULT_PAGE_SIZE): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

/**
 * Read a repeatable search param into a list.
 *
 * `searchParams` hands over `string | string[] | undefined`, and a single value
 * arrives as a bare string. Comma-separated values are also accepted so
 * `?severity=CRITICAL,HIGH` works as well as `?severity=CRITICAL&severity=HIGH`
 * — the second form is what the filter UI emits, the first is what people type.
 */
export function parseListParam(value: string | string[] | undefined | null): string[] {
  if (value === undefined || value === null) return [];

  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const token of entry.split(',')) {
      const trimmed = token.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
      if (out.length >= MAX_FILTER_VALUES) return out;
    }
  }

  return out;
}

/** Keep only recognised severities, in the canonical CRITICAL→NONE order. */
export function parseSeverityFilter(values: readonly string[]): Severity[] {
  const wanted = new Set(values.map((value) => value.trim().toUpperCase()));
  return SEVERITY_ORDER.filter((severity) => wanted.has(severity));
}

/** Keep only recognised triage statuses, de-duplicated and in declared order. */
export function parseStatusFilter(values: readonly string[]): FindingStatus[] {
  const wanted = new Set(values.map((value) => value.trim().toUpperCase()));
  return FINDING_STATUSES.filter((status) => wanted.has(status));
}

/** Resolve a sort key, falling back to `newest` for anything unrecognised. */
export function parseSort(value: unknown): FindingSort {
  if (typeof value !== 'string') return DEFAULT_SORT;
  const candidate = value.trim().toLowerCase();
  return (FINDING_SORTS as readonly string[]).includes(candidate)
    ? (candidate as FindingSort)
    : DEFAULT_SORT;
}

/**
 * Trim and bound a free-text search term.
 *
 * Returns `null` for anything empty so callers can test one thing rather than
 * distinguishing `undefined` from `''` from `'   '` — an empty-string search
 * would otherwise build an `OR` of three `contains: ''` clauses that match every
 * row while looking like a filter.
 */
export function normalizeSearch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_SEARCH_LENGTH);
}

/** Resolve a raw query into safe, in-range values. */
export function normalizeFindingsQuery(query: FindingsQuery = {}): NormalizedFindingsQuery {
  return {
    page: clampPage(query.page ?? 1),
    pageSize: clampPageSize(query.pageSize ?? DEFAULT_PAGE_SIZE),
    severity: parseSeverityFilter(query.severity ?? []),
    type: (query.type ?? [])
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_FILTER_VALUES),
    status: parseStatusFilter(query.status ?? []),
    repositoryId: typeof query.repositoryId === 'string' && query.repositoryId.trim()
      ? query.repositoryId.trim()
      : null,
    search: normalizeSearch(query.search),
    sort: parseSort(query.sort),
  };
}

/** Prisma `orderBy` for a sort key. */
export function buildFindingsOrderBy(sort: FindingSort): Record<string, unknown>[] {
  switch (sort) {
    case 'oldest':
      return [{ createdAt: 'asc' }];
    case 'file':
      return [{ fileLocation: 'asc' }, { createdAt: 'desc' }];
    case 'severity':
      // Handled by planSeverityPage rather than by an orderBy — see below. This
      // is only the within-bucket tiebreaker.
      return [{ createdAt: 'desc' }];
    case 'newest':
    default:
      return [{ createdAt: 'desc' }];
  }
}

/** True when the sort cannot be expressed as a plain Prisma `orderBy`. */
export function requiresSeverityPlan(sort: FindingSort): boolean {
  return sort === 'severity';
}

/** One contiguous read from a single severity bucket. */
export interface SeveritySlice {
  severity: Severity;
  skip: number;
  take: number;
}

/**
 * Plan a severity-ordered page as a list of per-bucket reads.
 *
 * `Finding.severity` is a plain `String` column, so `orderBy: { severity: 'asc' }`
 * sorts alphabetically — CRITICAL, HIGH, LOW, MEDIUM — which puts LOW above
 * MEDIUM and is not what anyone means by "sort by severity".
 *
 * Sorting the page in memory after fetching it does not fix that either: it can
 * only reorder rows the database already returned, so page 2 of a severity sort
 * would be "the second twenty rows by date, ranked among themselves" rather than
 * the twenty next-most-severe findings. That is wrong in a way that looks right,
 * which is worse than being obviously wrong.
 *
 * Severity has exactly five values, so the correct page is expressible as a
 * bounded walk: take the counts per bucket in CRITICAL→NONE order, skip forward
 * to the requested offset, and read at most `pageSize` rows spanning at most
 * five buckets. Each read is an ordinary indexed `skip`/`take` on one severity.
 *
 * Pure, so the arithmetic is testable without a database.
 */
export function planSeverityPage(
  counts: Readonly<Partial<Record<Severity, number>>>,
  page: number,
  pageSize: number
): SeveritySlice[] {
  const safePage = clampPage(page);
  const safeSize = clampPageSize(pageSize);

  let offset = (safePage - 1) * safeSize;
  let remaining = safeSize;
  const slices: SeveritySlice[] = [];

  for (const severity of SEVERITY_ORDER) {
    if (remaining <= 0) break;

    const available = Math.max(0, Math.floor(counts[severity] ?? 0));
    if (available === 0) continue;

    if (offset >= available) {
      // The whole bucket sits before the requested window.
      offset -= available;
      continue;
    }

    const take = Math.min(remaining, available - offset);
    slices.push({ severity, skip: offset, take });

    remaining -= take;
    offset = 0;
  }

  return slices;
}

export interface FindingsWhereContext {
  /** Owner of the repositories whose findings are in scope. */
  userId: string;
  /** Fingerprints the user has dismissed, from `getUserTriage`. */
  dismissedFingerprints: readonly string[];
  /**
   * Fingerprints carrying each triage status, used by the status filter.
   * Absent statuses are treated as empty.
   */
  fingerprintsByStatus?: Partial<Record<FindingStatus, readonly string[]>>;
}

/**
 * Build the Prisma `where` clause.
 *
 * Used by **both** the list query and every count, which is the point: the two
 * previously diverged, and a single builder is the only durable fix.
 *
 * `includeDismissed` is the one knob. The stat tiles pass `false` (their whole
 * purpose is to count outstanding risk); the list passes `false` too unless the
 * user has explicitly filtered to a dismissed status, in which case hiding the
 * rows they just asked for would be absurd.
 */
export function buildFindingsWhere(
  context: FindingsWhereContext,
  query: NormalizedFindingsQuery,
  options: { includeDismissed?: boolean } = {}
): Record<string, unknown> {
  const { userId, dismissedFingerprints, fingerprintsByStatus = {} } = context;

  const asksForDismissed = query.status.some((status) =>
    DISMISSED_STATUSES.includes(status)
  );
  const includeDismissed = options.includeDismissed ?? asksForDismissed;

  const where: Record<string, unknown> = {
    scanResult: {
      pullRequest: {
        repository: {
          userId,
          ...(query.repositoryId ? { id: query.repositoryId } : {}),
        },
      },
    },
  };

  if (!includeDismissed && dismissedFingerprints.length > 0) {
    where.fingerprint = { notIn: [...dismissedFingerprints] };
  }

  if (query.severity.length > 0) {
    where.severity = { in: query.severity };
  }

  if (query.type.length > 0) {
    where.type = { in: query.type };
  }

  // The status clause goes into `AND` alongside the blanket dismissal filter
  // rather than replacing it. For the list `includeDismissed` is already true
  // whenever a dismissed status was asked for, so `where.fingerprint` is unset
  // and only the explicit selection applies; for the stat tiles it stays set, so
  // asking the tiles to count FALSE_POSITIVEs correctly yields zero — their
  // whole purpose is to count outstanding risk.
  //
  // Both the status filter and the search build an `OR`, so they are collected
  // into `AND` rather than assigned to `where.OR`. Writing both to `where.OR`
  // would let the second silently overwrite the first — filtering by status and
  // searching at the same time would then quietly ignore the status.
  const andClauses: Record<string, unknown>[] = [];

  if (query.status.length > 0) {
    // Triage keys off the stable fingerprint rather than Finding.id (see
    // src/lib/triage/queries.ts), so a status filter resolves to a fingerprint
    // set rather than to a relation.
    const explicit: string[] = [];
    let includesOpen = false;

    for (const status of query.status) {
      if (status === 'OPEN') {
        // OPEN is the implicit default: a finding with no triage row at all.
        includesOpen = true;
        continue;
      }
      explicit.push(...(fingerprintsByStatus[status] ?? []));
    }

    const triaged = new Set<string>();
    for (const values of Object.values(fingerprintsByStatus)) {
      for (const fingerprint of values ?? []) triaged.add(fingerprint);
    }

    if (includesOpen && explicit.length > 0) {
      andClauses.push({
        OR: [
          { fingerprint: { notIn: [...triaged] } },
          { fingerprint: { in: [...new Set(explicit)] } },
        ],
      });
    } else if (includesOpen) {
      andClauses.push({ fingerprint: { notIn: [...triaged] } });
    } else {
      andClauses.push({ fingerprint: { in: [...new Set(explicit)] } });
    }
  }

  if (query.search) {
    andClauses.push({
      OR: [
        { type: { contains: query.search, mode: 'insensitive' } },
        { fileLocation: { contains: query.search, mode: 'insensitive' } },
        { explanation: { contains: query.search, mode: 'insensitive' } },
        { remediation: { contains: query.search, mode: 'insensitive' } },
      ],
    });
  }

  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  return where;
}

/** Total pages for a result count, floored at 1 so an empty list is "page 1 of 1". */
export function totalPagesFor(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/**
 * Clamp a requested page against the real total.
 *
 * Deleting the last finding on page 4 otherwise leaves the reader on an empty
 * page with no indication that anything exists.
 */
export function resolvePage(requested: number, total: number, pageSize: number): number {
  return Math.min(clampPage(requested), totalPagesFor(total, pageSize));
}

/** True when any filter is active, so the UI can offer "clear filters". */
export function hasActiveFilters(query: NormalizedFindingsQuery): boolean {
  return (
    query.severity.length > 0 ||
    query.type.length > 0 ||
    query.status.length > 0 ||
    query.repositoryId !== null ||
    query.search !== null
  );
}

/** Serialise a query back into a query string, omitting defaults. */
export function toSearchParams(query: NormalizedFindingsQuery): string {
  const params = new URLSearchParams();

  if (query.page > 1) params.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(query.pageSize));
  if (query.sort !== DEFAULT_SORT) params.set('sort', query.sort);
  if (query.repositoryId) params.set('repo', query.repositoryId);
  if (query.search) params.set('q', query.search);
  for (const severity of query.severity) params.append('severity', severity);
  for (const type of query.type) params.append('type', type);
  for (const status of query.status) params.append('status', status);

  return params.toString();
}

/** Parse the `searchParams` object a server component receives. */
export function fromSearchParams(
  params: Record<string, string | string[] | undefined> = {}
): NormalizedFindingsQuery {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  return normalizeFindingsQuery({
    page: Number(single(params.page) ?? 1),
    pageSize: Number(single(params.pageSize) ?? DEFAULT_PAGE_SIZE),
    severity: parseListParam(params.severity),
    type: parseListParam(params.type),
    status: parseListParam(params.status),
    repositoryId: single(params.repo),
    search: single(params.q),
    sort: single(params.sort),
  });
}

/** Re-exported so callers can type-guard a severity without a second import. */
export { isSeverity };
export type { Severity };
