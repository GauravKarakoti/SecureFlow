import { describe, it, expect } from 'vitest';
import { SUPPRESSED_STATUSES } from '@/lib/triage/queries';
import { SEVERITY_ORDER } from '@/lib/severity';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  DISMISSED_STATUSES,
  FINDING_SORTS,
  FINDING_STATUSES,
  MAX_PAGE_SIZE,
  buildFindingsOrderBy,
  buildFindingsWhere,
  clampPage,
  clampPageSize,
  fromSearchParams,
  hasActiveFilters,
  normalizeFindingsQuery,
  normalizeSearch,
  parseListParam,
  parseSeverityFilter,
  parseSort,
  parseStatusFilter,
  planSeverityPage,
  requiresSeverityPlan,
  resolvePage,
  toSearchParams,
  totalPagesFor,
} from './query';

const CONTEXT = {
  userId: 'user-1',
  dismissedFingerprints: ['fp-dismissed-a', 'fp-dismissed-b'],
  fingerprintsByStatus: {
    RESOLVED: ['fp-resolved'],
    FALSE_POSITIVE: ['fp-dismissed-a'],
    IGNORED: ['fp-dismissed-b'],
  },
};

describe('clampPage', () => {
  it('floors at 1', () => {
    // ?page=0 produces skip: -pageSize, which Prisma rejects at runtime.
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-5)).toBe(1);
  });

  it('falls back to 1 for values that are not numbers', () => {
    // NaN would make `skip` NaN and silently return nothing at all.
    expect(clampPage('not-a-number')).toBe(1);
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage(Number.NaN)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('truncates fractional pages', () => {
    expect(clampPage(3.9)).toBe(3);
  });

  it('accepts a numeric string, as searchParams always supplies', () => {
    expect(clampPage('4')).toBe(4);
  });
});

describe('clampPageSize', () => {
  it('caps at MAX_PAGE_SIZE so a hand-edited URL cannot pull the whole table', () => {
    expect(clampPageSize(100000)).toBe(MAX_PAGE_SIZE);
  });

  it('floors at 1', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-20)).toBe(1);
  });

  it('defaults when unparseable', () => {
    expect(clampPageSize('abc')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe('parseListParam', () => {
  it('reads a bare string, which is how a single value arrives', () => {
    expect(parseListParam('CRITICAL')).toEqual(['CRITICAL']);
  });

  it('reads a repeated param', () => {
    expect(parseListParam(['CRITICAL', 'HIGH'])).toEqual(['CRITICAL', 'HIGH']);
  });

  it('also accepts the comma-separated form people type by hand', () => {
    expect(parseListParam('CRITICAL,HIGH')).toEqual(['CRITICAL', 'HIGH']);
  });

  it('trims, drops blanks and de-duplicates', () => {
    expect(parseListParam([' CRITICAL ', '', 'CRITICAL', '  '])).toEqual(['CRITICAL']);
  });

  it('returns an empty list for absent input', () => {
    expect(parseListParam(undefined)).toEqual([]);
    expect(parseListParam(null)).toEqual([]);
  });

  it('bounds the number of values a single filter can carry', () => {
    const many = Array.from({ length: 200 }, (_, index) => `type-${index}`);
    expect(parseListParam(many).length).toBeLessThanOrEqual(20);
  });
});

describe('parseSeverityFilter', () => {
  it('keeps only recognised severities', () => {
    expect(parseSeverityFilter(['CRITICAL', 'BOGUS', 'LOW'])).toEqual(['CRITICAL', 'LOW']);
  });

  it('normalises case', () => {
    expect(parseSeverityFilter(['critical', ' high '])).toEqual(['CRITICAL', 'HIGH']);
  });

  it('returns canonical order regardless of input order', () => {
    expect(parseSeverityFilter(['LOW', 'CRITICAL', 'MEDIUM'])).toEqual([
      'CRITICAL',
      'MEDIUM',
      'LOW',
    ]);
  });
});

describe('parseStatusFilter', () => {
  it('keeps only recognised statuses', () => {
    expect(parseStatusFilter(['OPEN', 'NOT_A_STATUS', 'IGNORED'])).toEqual(['OPEN', 'IGNORED']);
  });

  it('de-duplicates', () => {
    expect(parseStatusFilter(['OPEN', 'open'])).toEqual(['OPEN']);
  });
});

describe('parseSort', () => {
  it.each(FINDING_SORTS)('accepts %s', (sort) => {
    expect(parseSort(sort)).toBe(sort);
  });

  it('falls back to the default for anything unrecognised', () => {
    expect(parseSort('severity; DROP TABLE')).toBe(DEFAULT_SORT);
    expect(parseSort(undefined)).toBe(DEFAULT_SORT);
    expect(parseSort(42)).toBe(DEFAULT_SORT);
  });
});

describe('normalizeSearch', () => {
  it('returns null for anything empty', () => {
    // An empty-string search would build three `contains: ''` clauses that
    // match every row while looking like a filter.
    expect(normalizeSearch('')).toBeNull();
    expect(normalizeSearch('   ')).toBeNull();
    expect(normalizeSearch(undefined)).toBeNull();
  });

  it('trims and bounds the term', () => {
    expect(normalizeSearch('  aws key  ')).toBe('aws key');
    expect(normalizeSearch('x'.repeat(5000))!.length).toBe(200);
  });
});

describe('normalizeFindingsQuery', () => {
  it('resolves an empty query to safe defaults', () => {
    expect(normalizeFindingsQuery()).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      severity: [],
      type: [],
      status: [],
      repositoryId: null,
      search: null,
      sort: DEFAULT_SORT,
    });
  });

  it('clamps hostile input rather than passing it to Prisma', () => {
    const normalized = normalizeFindingsQuery({
      page: -3,
      pageSize: 999999,
      severity: ['nonsense'],
      status: ['nonsense'],
      sort: 'nonsense',
      search: '   ',
    });

    expect(normalized.page).toBe(1);
    expect(normalized.pageSize).toBe(MAX_PAGE_SIZE);
    expect(normalized.severity).toEqual([]);
    expect(normalized.status).toEqual([]);
    expect(normalized.sort).toBe(DEFAULT_SORT);
    expect(normalized.search).toBeNull();
  });

  it('treats a blank repository id as no filter', () => {
    expect(normalizeFindingsQuery({ repositoryId: '   ' }).repositoryId).toBeNull();
  });

  it('is idempotent, so a normalized query can be fed straight back in', () => {
    // The page normalizes once from searchParams and hands the result to the
    // server action, which normalizes again — that must be a no-op rather than
    // a second, subtly different shape.
    const once = normalizeFindingsQuery({
      page: 2,
      pageSize: 50,
      severity: ['CRITICAL'],
      type: ['Secret'],
      status: ['OPEN'],
      repositoryId: 'repo-1',
      search: 'aws',
      sort: 'severity',
    });

    expect(normalizeFindingsQuery(once)).toEqual(once);
  });

  it('accepts nulls, which is what an absent searchParam resolves to', () => {
    expect(
      normalizeFindingsQuery({
        page: null,
        pageSize: null,
        severity: null,
        repositoryId: null,
        search: null,
        sort: null,
      })
    ).toEqual(normalizeFindingsQuery());
  });
});

describe('buildFindingsWhere', () => {
  it('always scopes to repositories the user owns', () => {
    const where = buildFindingsWhere(CONTEXT, normalizeFindingsQuery()) as any;
    expect(where.scanResult.pullRequest.repository.userId).toBe('user-1');
  });

  it('excludes dismissed fingerprints by default', () => {
    const where = buildFindingsWhere(CONTEXT, normalizeFindingsQuery()) as any;
    expect(where.fingerprint).toEqual({ notIn: ['fp-dismissed-a', 'fp-dismissed-b'] });
  });

  it('builds the same dismissal clause for the tiles and the list', () => {
    // The two used to diverge: the tiles applied the filter, the list did not,
    // so a fully-triaged repository showed 0/0/0 above fifty dismissed rows.
    const query = normalizeFindingsQuery();
    const list = buildFindingsWhere(CONTEXT, query);
    const tiles = buildFindingsWhere(CONTEXT, query, { includeDismissed: false });
    expect(list).toEqual(tiles);
  });

  it('stops hiding dismissed rows once the user filters to a dismissed status', () => {
    const where = buildFindingsWhere(
      CONTEXT,
      normalizeFindingsQuery({ status: ['FALSE_POSITIVE'] })
    ) as any;

    expect(where.AND).toContainEqual({ fingerprint: { in: ['fp-dismissed-a'] } });
  });

  it('keeps the tiles free of dismissed rows even then', () => {
    const where = buildFindingsWhere(
      CONTEXT,
      normalizeFindingsQuery({ status: ['FALSE_POSITIVE'] }),
      { includeDismissed: false }
    ) as any;

    expect(where.fingerprint).toEqual({ notIn: ['fp-dismissed-a', 'fp-dismissed-b'] });
  });

  it('resolves OPEN to "has no triage row at all"', () => {
    const where = buildFindingsWhere(CONTEXT, normalizeFindingsQuery({ status: ['OPEN'] })) as any;

    expect(where.AND).toContainEqual({
      fingerprint: { notIn: expect.arrayContaining(['fp-resolved', 'fp-dismissed-a']) },
    });
  });

  it('unions OPEN with an explicit status', () => {
    const where = buildFindingsWhere(
      CONTEXT,
      normalizeFindingsQuery({ status: ['OPEN', 'RESOLVED'] })
    ) as any;

    const clause = where.AND.find((entry: any) => Array.isArray(entry.OR));
    expect(clause.OR).toHaveLength(2);
    expect(clause.OR[1]).toEqual({ fingerprint: { in: ['fp-resolved'] } });
  });

  it('applies severity, type and repository filters', () => {
    const where = buildFindingsWhere(
      CONTEXT,
      normalizeFindingsQuery({
        severity: ['CRITICAL'],
        type: ['Secret'],
        repositoryId: 'repo-9',
      })
    ) as any;

    expect(where.severity).toEqual({ in: ['CRITICAL'] });
    expect(where.type).toEqual({ in: ['Secret'] });
    expect(where.scanResult.pullRequest.repository.id).toBe('repo-9');
  });

  it('searches across type, file, explanation and remediation, case-insensitively', () => {
    const where = buildFindingsWhere(
      CONTEXT,
      normalizeFindingsQuery({ search: 'aws' })
    ) as any;

    const clause = where.AND.find((entry: any) => Array.isArray(entry.OR));
    expect(clause.OR).toEqual([
      { type: { contains: 'aws', mode: 'insensitive' } },
      { fileLocation: { contains: 'aws', mode: 'insensitive' } },
      { explanation: { contains: 'aws', mode: 'insensitive' } },
      { remediation: { contains: 'aws', mode: 'insensitive' } },
    ]);
  });

  it('keeps both the status filter and the search when they are combined', () => {
    // Both build an OR. Assigning both to `where.OR` would let the second
    // silently overwrite the first, so filtering and searching together would
    // quietly ignore the filter.
    const where = buildFindingsWhere(
      CONTEXT,
      normalizeFindingsQuery({ status: ['RESOLVED'], search: 'aws' })
    ) as any;

    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual({ fingerprint: { in: ['fp-resolved'] } });
    expect(where.AND[1].OR).toHaveLength(4);
  });

  it('omits the dismissal clause when the user has dismissed nothing', () => {
    const where = buildFindingsWhere(
      { userId: 'user-1', dismissedFingerprints: [] },
      normalizeFindingsQuery()
    ) as any;

    expect(where.fingerprint).toBeUndefined();
  });
});

describe('DISMISSED_STATUSES', () => {
  it('agrees with SUPPRESSED_STATUSES in the triage module', () => {
    // These must match or the tiles and the list drift apart again.
    expect([...DISMISSED_STATUSES].sort()).toEqual([...SUPPRESSED_STATUSES].sort());
  });

  it('is a subset of the declared statuses', () => {
    for (const status of DISMISSED_STATUSES) {
      expect(FINDING_STATUSES).toContain(status);
    }
  });
});

describe('buildFindingsOrderBy', () => {
  it('orders newest first by default', () => {
    expect(buildFindingsOrderBy('newest')).toEqual([{ createdAt: 'desc' }]);
  });

  it('reverses for oldest', () => {
    expect(buildFindingsOrderBy('oldest')).toEqual([{ createdAt: 'asc' }]);
  });

  it('groups by file with a date tiebreaker', () => {
    expect(buildFindingsOrderBy('file')).toEqual([
      { fileLocation: 'asc' },
      { createdAt: 'desc' },
    ]);
  });
});

describe('planSeverityPage', () => {
  const counts = { CRITICAL: 3, HIGH: 5, MEDIUM: 2, LOW: 10, NONE: 0 };

  it('fills the first page from the most severe buckets down', () => {
    expect(planSeverityPage(counts, 1, 5)).toEqual([
      { severity: 'CRITICAL', skip: 0, take: 3 },
      { severity: 'HIGH', skip: 0, take: 2 },
    ]);
  });

  it('resumes mid-bucket on the next page', () => {
    // This is the case an in-memory sort gets wrong: page 2 must be the next
    // five most severe findings, not the second five by date re-ranked.
    expect(planSeverityPage(counts, 2, 5)).toEqual([
      { severity: 'HIGH', skip: 2, take: 3 },
      { severity: 'MEDIUM', skip: 0, take: 2 },
    ]);
  });

  it('skips empty buckets entirely', () => {
    expect(planSeverityPage({ CRITICAL: 0, HIGH: 2 }, 1, 5)).toEqual([
      { severity: 'HIGH', skip: 0, take: 2 },
    ]);
  });

  it('returns nothing past the end of the data', () => {
    expect(planSeverityPage(counts, 99, 5)).toEqual([]);
  });

  it('never spans more buckets than there are severities', () => {
    const plan = planSeverityPage({ CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1, NONE: 1 }, 1, 100);
    expect(plan.length).toBeLessThanOrEqual(SEVERITY_ORDER.length);
  });

  it('requests exactly pageSize rows when enough exist', () => {
    const plan = planSeverityPage(counts, 1, 12);
    expect(plan.reduce((sum, slice) => sum + slice.take, 0)).toBe(12);
  });

  it('emits slices in canonical severity order', () => {
    const plan = planSeverityPage(counts, 1, 20);
    const order = plan.map((slice) => SEVERITY_ORDER.indexOf(slice.severity));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('tolerates a missing or negative count', () => {
    expect(planSeverityPage({ CRITICAL: -4, HIGH: 2 }, 1, 5)).toEqual([
      { severity: 'HIGH', skip: 0, take: 2 },
    ]);
  });

  it('is only used for the severity sort', () => {
    expect(requiresSeverityPlan('severity')).toBe(true);
    expect(requiresSeverityPlan('newest')).toBe(false);
    expect(requiresSeverityPlan('file')).toBe(false);
  });
});

describe('totalPagesFor / resolvePage', () => {
  it('reports one page for an empty result', () => {
    expect(totalPagesFor(0, 20)).toBe(1);
  });

  it('rounds a partial page up', () => {
    expect(totalPagesFor(41, 20)).toBe(3);
  });

  it('pulls a request past the end back to the last real page', () => {
    // Deleting the last finding on page 4 otherwise strands the reader on a
    // blank page with no sign that anything exists.
    expect(resolvePage(4, 25, 20)).toBe(2);
  });

  it('leaves a valid page alone', () => {
    expect(resolvePage(2, 100, 20)).toBe(2);
  });
});

describe('hasActiveFilters', () => {
  it('is false for a default query', () => {
    expect(hasActiveFilters(normalizeFindingsQuery())).toBe(false);
  });

  it.each([
    ['severity', { severity: ['CRITICAL'] }],
    ['type', { type: ['Secret'] }],
    ['status', { status: ['OPEN'] }],
    ['repository', { repositoryId: 'repo-1' }],
    ['search', { search: 'aws' }],
  ])('is true when %s is set', (_label, patch) => {
    expect(hasActiveFilters(normalizeFindingsQuery(patch))).toBe(true);
  });

  it('is not triggered by pagination or sorting alone', () => {
    expect(hasActiveFilters(normalizeFindingsQuery({ page: 3, sort: 'file' }))).toBe(false);
  });
});

describe('searchParams round-trip', () => {
  it('omits defaults so a clean view has a clean URL', () => {
    expect(toSearchParams(normalizeFindingsQuery())).toBe('');
  });

  it('serialises every filter', () => {
    const params = toSearchParams(
      normalizeFindingsQuery({
        page: 2,
        sort: 'severity',
        severity: ['CRITICAL', 'HIGH'],
        type: ['Secret'],
        status: ['OPEN'],
        repositoryId: 'repo-1',
        search: 'aws key',
      })
    );

    expect(params).toContain('page=2');
    expect(params).toContain('sort=severity');
    expect(params).toContain('severity=CRITICAL');
    expect(params).toContain('severity=HIGH');
    expect(params).toContain('type=Secret');
    expect(params).toContain('status=OPEN');
    expect(params).toContain('repo=repo-1');
    expect(params).toContain('q=aws+key');
  });

  it('parses back to the same normalized query', () => {
    const original = normalizeFindingsQuery({
      page: 3,
      pageSize: 50,
      sort: 'file',
      severity: ['CRITICAL'],
      type: ['Secret', 'Misconfig'],
      status: ['RESOLVED'],
      repositoryId: 'repo-7',
      search: 'token',
    });

    const params = new URLSearchParams(toSearchParams(original));
    const asRecord: Record<string, string | string[]> = {};
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      asRecord[key] = values.length > 1 ? values : values[0];
    }

    expect(fromSearchParams(asRecord)).toEqual(original);
  });

  it('survives a hostile searchParams object', () => {
    const parsed = fromSearchParams({
      page: ['-9'],
      pageSize: '1000000',
      severity: 'DROP TABLE',
      sort: ['../../etc/passwd'],
      q: ' '.repeat(50),
    });

    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(MAX_PAGE_SIZE);
    expect(parsed.severity).toEqual([]);
    expect(parsed.sort).toBe(DEFAULT_SORT);
    expect(parsed.search).toBeNull();
  });
});
