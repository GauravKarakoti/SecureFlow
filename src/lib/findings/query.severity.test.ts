import { describe, expect, it } from 'vitest';

import { STORED_SEVERITIES, type StoredSeverity } from '@/lib/severity';
import {
  buildFindingsWhere,
  fromSearchParams,
  hasActiveFilters,
  normalizeFindingsQuery,
  parseSeverityFilter,
  planSeverityPage,
  toSearchParams,
  totalPagesFor,
} from './query';

const context = { userId: 'user-1', dismissedFingerprints: [] as string[] };

/** Every severity value a `where` clause ends up carrying, flattened. */
function severityValuesIn(where: Record<string, unknown>): string[] {
  const clause = where.severity as { in?: string[] } | undefined;
  return clause?.in ?? [];
}

describe('parseSeverityFilter only produces values the enum accepts (#686)', () => {
  it('resolves NONE onto INFO instead of emitting a value Prisma rejects', () => {
    // The 500: `{ severity: { in: ['NONE'] } }` against a FindingSeverity enum
    // is a PrismaClientValidationError, and 'NONE' was a value this module's
    // own parser handed out.
    expect(parseSeverityFilter(['NONE'])).toEqual(['INFO']);
    expect(parseSeverityFilter(['none'])).toEqual(['INFO']);
  });

  it('keeps INFO instead of silently dropping it', () => {
    // The no-op filter: INFO is offered by the severity dropdown as soon as one
    // such finding exists, and normalising it to [] meant clicking it changed
    // nothing and rewrote itself out of the URL.
    expect(parseSeverityFilter(['INFO'])).toEqual(['INFO']);
  });

  it('still accepts the four levels it always did', () => {
    expect(parseSeverityFilter(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
    ]);
  });

  it('returns results in canonical order regardless of request order', () => {
    expect(parseSeverityFilter(['LOW', 'CRITICAL', 'INFO', 'HIGH'])).toEqual([
      'CRITICAL',
      'HIGH',
      'LOW',
      'INFO',
    ]);
  });

  it('collapses aliases that resolve to the same bucket', () => {
    expect(parseSeverityFilter(['NONE', 'INFO', 'informational'])).toEqual(['INFO']);
    expect(parseSeverityFilter(['CRITICAL', 'sev1', 'P0'])).toEqual(['CRITICAL']);
  });

  it('accepts alias spellings a user might type', () => {
    expect(parseSeverityFilter(['crit'])).toEqual(['CRITICAL']);
    expect(parseSeverityFilter(['error'])).toEqual(['HIGH']);
    expect(parseSeverityFilter(['warning'])).toEqual(['MEDIUM']);
  });

  it('drops values that mean nothing', () => {
    expect(parseSeverityFilter(['banana', '', '   '])).toEqual([]);
  });

  it('never emits a value outside the enum, for any input', () => {
    const inputs = [
      'NONE', 'none', 'INFO', 'clean', 'pass', 'ok', 'unknown', 'sev0', 'p4',
      'CRITICAL', 'critical', 'note', 'notice', 'trivial', 'major', 'banana',
    ];

    for (const input of inputs) {
      for (const value of parseSeverityFilter([input])) {
        expect(STORED_SEVERITIES, `${input} -> ${value}`).toContain(value);
      }
    }
  });
});

describe('buildFindingsWhere emits enum-valid severity clauses', () => {
  it('does not put NONE into the query', () => {
    const query = normalizeFindingsQuery({ severity: ['NONE'] });
    const where = buildFindingsWhere(context, query);

    expect(severityValuesIn(where)).toEqual(['INFO']);
    expect(severityValuesIn(where)).not.toContain('NONE');
  });

  it('actually filters when INFO is requested', () => {
    const query = normalizeFindingsQuery({ severity: ['INFO'] });
    const where = buildFindingsWhere(context, query);

    expect(severityValuesIn(where)).toEqual(['INFO']);
  });

  it('omits the clause entirely when nothing resolved', () => {
    const where = buildFindingsWhere(context, normalizeFindingsQuery({ severity: ['banana'] }));
    expect(where.severity).toBeUndefined();
  });
});

describe('an INFO filter round-trips through the URL', () => {
  it('is reported as an active filter', () => {
    // Previously false: the filter normalised away, so no chip and no "clear
    // filters" affordance were rendered for a filter the user had just set.
    expect(hasActiveFilters(normalizeFindingsQuery({ severity: ['INFO'] }))).toBe(true);
  });

  it('survives serialisation back into a query string', () => {
    // Previously the parameter was dropped here, so the URL reset itself.
    const query = fromSearchParams({ severity: 'INFO' });
    expect(query.severity).toEqual(['INFO']);
    expect(toSearchParams(query)).toContain('severity=INFO');
  });

  it('rewrites a NONE request as the bucket that exists', () => {
    const query = fromSearchParams({ severity: 'NONE' });
    expect(toSearchParams(query)).toContain('severity=INFO');
  });
});

describe('planSeverityPage covers every bucket the column can hold', () => {
  it('emits a slice for INFO', () => {
    expect(planSeverityPage({ INFO: 5 }, 1, 20)).toEqual([{ severity: 'INFO', skip: 0, take: 5 }]);
  });

  it('walks the buckets most severe first', () => {
    const slices = planSeverityPage(
      { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1, INFO: 1 },
      1,
      5
    );

    expect(slices.map((slice) => slice.severity)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
      'INFO',
    ]);
  });

  it('never plans a slice for a bucket the column cannot hold', () => {
    const slices = planSeverityPage(
      { CRITICAL: 3, INFO: 3 } as Partial<Record<StoredSeverity, number>>,
      1,
      10
    );

    for (const slice of slices) {
      expect(STORED_SEVERITIES).toContain(slice.severity);
    }
  });

  describe('the 10 CRITICAL + 20 INFO case from the report', () => {
    const counts = { CRITICAL: 10, INFO: 20 };
    const total = 30;
    const pageSize = 20;

    it('advertises two pages', () => {
      expect(totalPagesFor(total, pageSize)).toBe(2);
    });

    it('fills page one rather than stopping at the CRITICAL bucket', () => {
      const slices = planSeverityPage(counts, 1, pageSize);
      const rows = slices.reduce((sum, slice) => sum + slice.take, 0);

      // Was 10 — the page claimed 20 and rendered half of them.
      expect(rows).toBe(20);
      expect(slices).toEqual([
        { severity: 'CRITICAL', skip: 0, take: 10 },
        { severity: 'INFO', skip: 0, take: 10 },
      ]);
    });

    it('renders the remainder on page two rather than nothing', () => {
      const slices = planSeverityPage(counts, 2, pageSize);

      // Was []: the walk ran out of buckets and produced a blank page.
      expect(slices).toEqual([{ severity: 'INFO', skip: 10, take: 10 }]);
    });

    it('reaches every row across the two pages, exactly once', () => {
      const seen = new Map<string, number>();

      for (const page of [1, 2]) {
        for (const slice of planSeverityPage(counts, page, pageSize)) {
          for (let offset = 0; offset < slice.take; offset += 1) {
            const key = `${slice.severity}#${slice.skip + offset}`;
            seen.set(key, (seen.get(key) ?? 0) + 1);
          }
        }
      }

      expect(seen.size).toBe(total);
      expect([...seen.values()].every((count) => count === 1)).toBe(true);
    });
  });
});
