import { describe, it, expect } from 'vitest';

import {
  MAX_EXPORT_ROWS,
  omittedRowCount,
  summarizeExport,
  type UserAuditLogRow,
} from './export-limits';

function row(i: number): UserAuditLogRow {
  return {
    id: `log-${i}`,
    userId: 'user-1',
    action: 'SCAN',
    resource: 'acme/api',
    decision: 'PASS',
    metadata: null,
    timestamp: new Date(1_700_000_000_000 + i),
  };
}

function rows(n: number): UserAuditLogRow[] {
  return Array.from({ length: n }, (_, i) => row(i));
}

describe('MAX_EXPORT_ROWS', () => {
  it('is a plain number, not a server-reference stub', () => {
    // The whole point of this module: the value has to survive being imported
    // by a `"use server"` file without being rewritten into a callable.
    expect(typeof MAX_EXPORT_ROWS).toBe('number');
    expect(MAX_EXPORT_ROWS).toBe(5000);
  });

  it('is a positive integer, so Prisma `take` is always valid', () => {
    expect(Number.isInteger(MAX_EXPORT_ROWS)).toBe(true);
    expect(MAX_EXPORT_ROWS).toBeGreaterThan(0);
  });
});

describe('summarizeExport', () => {
  it('reports a short read as complete', () => {
    const result = summarizeExport(rows(12), 12);

    expect(result).toMatchObject({ total: 12, truncated: false, limit: MAX_EXPORT_ROWS });
    expect(result.rows).toHaveLength(12);
  });

  it('reports an empty result as complete rather than truncated', () => {
    const result = summarizeExport([], 0);

    expect(result.truncated).toBe(false);
    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('reports a read stopped by the cap as truncated', () => {
    const result = summarizeExport(rows(MAX_EXPORT_ROWS), 40_000);

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(40_000);
    expect(result.rows).toHaveLength(MAX_EXPORT_ROWS);
  });

  it('treats a match of exactly the cap as complete', () => {
    // `rows.length === limit` is not evidence of truncation: a filter that
    // selects precisely 5,000 rows produces a complete file, and warning about
    // it would be a lie on the one screen that must not lie.
    const result = summarizeExport(rows(MAX_EXPORT_ROWS), MAX_EXPORT_ROWS);

    expect(result.truncated).toBe(false);
  });

  it('honours a caller-supplied limit', () => {
    const result = summarizeExport(rows(10), 25, 10);

    expect(result.limit).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('clamps a count that came back lower than the page just read', () => {
    // `findMany` and `count` are two queries. A delete landing between them can
    // return a total below the rows already in hand; reporting that verbatim
    // would render as "exported 12 of 9 entries".
    const result = summarizeExport(rows(12), 9);

    expect(result.total).toBe(12);
    expect(result.truncated).toBe(false);
  });

  it('does not copy or reorder the rows it was handed', () => {
    const input = rows(3);
    const result = summarizeExport(input, 3);

    expect(result.rows).toBe(input);
  });
});

describe('omittedRowCount', () => {
  it('counts the rows the cap left behind', () => {
    expect(omittedRowCount(summarizeExport(rows(MAX_EXPORT_ROWS), 40_000))).toBe(35_000);
  });

  it('is zero for a complete export', () => {
    expect(omittedRowCount(summarizeExport(rows(12), 12))).toBe(0);
  });

  it('never goes negative', () => {
    expect(omittedRowCount(summarizeExport(rows(12), 9))).toBe(0);
  });
});
