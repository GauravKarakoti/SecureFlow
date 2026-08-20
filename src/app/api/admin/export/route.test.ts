/**
 * Tests for the audit-log export's range and keyset helpers (#592).
 *
 * The handler itself needs a session, a rate limiter and a database, so what is
 * tested here are the pure pieces it is built from: how a range is resolved,
 * and whether the keyset clause is actually stable. The paging behaviour is
 * covered in `src/lib/utils/csv-stream.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

import {
  AUDIT_LOG_EXPORT_COLUMNS,
  DEFAULT_EXPORT_WINDOW_DAYS,
  EXPORT_BATCH_SIZE,
  MAX_EXPORT_ROWS,
  buildExportWhere,
  describeRange,
  exportFilename,
  parseDateParam,
  parseLimitParam,
  resolveExportRange,
  type ExportRange,
} from './route';

const params = (query: string) => new URLSearchParams(query);
const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('parseDateParam', () => {
  it('returns undefined for an absent or empty value', () => {
    expect(parseDateParam(null, 'from')).toBeUndefined();
    expect(parseDateParam('', 'from')).toBeUndefined();
    expect(parseDateParam('   ', 'from')).toBeUndefined();
  });

  it('parses an ISO-8601 date', () => {
    expect(parseDateParam('2026-01-01', 'from')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws on a malformed date rather than ignoring it', () => {
    // Silently ignoring a typo would hand back a different range than the
    // operator asked for, which for an audit export is worse than an error.
    expect(() => parseDateParam('last-tuesday', 'from')).toThrow(/Invalid `from`/);
  });
});

describe('parseLimitParam', () => {
  it('returns undefined when absent', () => {
    expect(parseLimitParam(null, 100)).toBeUndefined();
  });

  it('clamps to the ceiling', () => {
    expect(parseLimitParam('999999', 100)).toBe(100);
  });

  it.each(['0', '-1', '1.5', 'abc', 'Infinity'])('rejects %j', (raw) => {
    expect(() => parseLimitParam(raw, 100)).toThrow(/Invalid `limit`/);
  });
});

describe('resolveExportRange', () => {
  it('defaults to a bounded recent window rather than all of history', () => {
    const range = resolveExportRange(params(''), NOW);

    expect(range.to).toBeUndefined();
    expect(range.from).toBeInstanceOf(Date);

    const days = (NOW.getTime() - range.from!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(DEFAULT_EXPORT_WINDOW_DAYS);
  });

  it('defaults the limit to the ceiling', () => {
    expect(resolveExportRange(params(''), NOW).limit).toBe(MAX_EXPORT_ROWS);
  });

  it('honours an explicit from, and does not then apply the default window', () => {
    // The documented escape hatch for "I really do want everything".
    const range = resolveExportRange(params('from=1970-01-01'), NOW);

    expect(range.from?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('honours an explicit to on its own, leaving from open', () => {
    const range = resolveExportRange(params('to=2026-01-01'), NOW);

    expect(range.from).toBeUndefined();
    expect(range.to?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects an inverted range', () => {
    expect(() => resolveExportRange(params('from=2026-06-01&to=2026-01-01'), NOW)).toThrow(
      /`from` is after `to`/,
    );
  });
});

describe('buildExportWhere', () => {
  const range: ExportRange = {
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-02-01T00:00:00.000Z'),
    limit: 100,
  };

  it('bounds the first page by the range only', () => {
    expect(buildExportWhere(range, null)).toEqual({
      timestamp: { gte: range.from, lte: range.to },
    });
  });

  it('omits the timestamp filter entirely when the range is open', () => {
    expect(buildExportWhere({ limit: 10 }, null)).toEqual({});
  });

  it('seeks past the cursor with a tuple comparison, not an offset', () => {
    // `timestamp` is not unique — the worker writes several AuditLog rows for a
    // single webhook — so a `timestamp < cursor` clause alone would skip every
    // row sharing the boundary timestamp. The id tiebreak is what makes the
    // walk complete.
    const cursor = { timestamp: new Date('2026-01-15T00:00:00.000Z'), id: 'cuid-42' };
    const where = buildExportWhere(range, cursor) as Record<string, unknown>;

    expect(where.OR).toEqual([
      { timestamp: { lt: cursor.timestamp } },
      { timestamp: cursor.timestamp, id: { gt: cursor.id } },
    ]);
  });

  it('keeps the range filter alongside the cursor clause', () => {
    const cursor = { timestamp: new Date('2026-01-15T00:00:00.000Z'), id: 'cuid-42' };
    const where = buildExportWhere(range, cursor) as Record<string, unknown>;

    expect(where.timestamp).toEqual({ gte: range.from, lte: range.to });
  });
});

describe('response metadata', () => {
  it('names the file after the range so two exports do not collide', () => {
    const range: ExportRange = {
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-02-01T00:00:00.000Z'),
      limit: 100,
    };

    expect(exportFilename(range)).toBe('audit_logs_2026-01-01_to_2026-02-01.csv');
  });

  it('marks an open bound rather than leaving a blank in the name', () => {
    expect(exportFilename({ limit: 100 })).toBe('audit_logs_all_to_all.csv');
  });

  it('describes an open range in words', () => {
    expect(describeRange({ limit: 100 })).toBe('beginning..now');
  });
});

describe('export shape', () => {
  it('keeps the column order stable', () => {
    // Downstream tooling parses this file positionally; reordering is a
    // breaking change, so the order is asserted rather than assumed.
    expect([...AUDIT_LOG_EXPORT_COLUMNS]).toEqual([
      'id',
      'userId',
      'action',
      'resource',
      'decision',
      'metadata',
      'timestamp',
    ]);
  });

  it('uses a batch size that bounds memory without one query per row', () => {
    expect(EXPORT_BATCH_SIZE).toBeGreaterThan(1);
    expect(EXPORT_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });
});
