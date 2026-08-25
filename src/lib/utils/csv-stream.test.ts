/**
 * Tests for streaming CSV serialisation (#592).
 *
 * The property that matters most is byte-for-byte agreement with `toCsv`: two
 * export paths that disagree about quoting would mean the formula-injection
 * defence applies on one and not the other. There is a test for that directly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_CSV_BATCH_SIZE,
  collectCsvStream,
  serializeCsvHeader,
  serializeCsvRow,
  streamCsv,
  type CsvPageFetcher,
  type CsvRow,
} from './csv-stream';
import { CSV_BOM, CSV_ROW_SEPARATOR, toCsv } from './csv';

/** A fetcher over a fixed in-memory array, paged the way the route pages. */
function pagerOver(rows: CsvRow[]): { fetch: CsvPageFetcher<number>; calls: () => number } {
  let calls = 0;

  const fetch: CsvPageFetcher<number> = async (cursor, take) => {
    calls += 1;
    const start = cursor ?? 0;
    const page = rows.slice(start, start + take);
    return { rows: page, nextCursor: page.length > 0 ? start + page.length : null };
  };

  return { fetch, calls: () => calls };
}

const HEADERS = ['id', 'action', 'resource'];

const sample: CsvRow[] = [
  { id: '1', action: 'Scan Triggered', resource: 'acme/api#1' },
  { id: '2', action: 'Policy Evaluation', resource: 'acme/api#1' },
  { id: '3', action: 'PR Comment Posted', resource: 'acme/api#2' },
];

describe('serializeCsvRow', () => {
  it('emits cells in header order regardless of key order', () => {
    expect(serializeCsvRow({ resource: 'r', id: '1', action: 'a' }, HEADERS)).toBe('1,a,r');
  });

  it('emits an empty cell for a missing key', () => {
    expect(serializeCsvRow({ id: '1' }, HEADERS)).toBe('1,,');
  });

  it('quotes a cell containing a comma', () => {
    expect(serializeCsvRow({ id: '1', action: 'a,b', resource: 'r' }, HEADERS)).toBe('1,"a,b",r');
  });

  it('neutralises a formula-injection cell', () => {
    // The whole reason this shares ./csv rather than re-implementing quoting.
    const row = { id: '1', action: '=cmd|\'/c calc\'!A1', resource: 'r' };

    expect(serializeCsvRow(row, HEADERS)).toContain("'=cmd");
  });

  it('tolerates a null row rather than throwing mid-stream', () => {
    expect(serializeCsvRow(null as unknown as CsvRow, HEADERS)).toBe(',,');
  });
});

describe('serializeCsvHeader', () => {
  it('escapes header names the same way data cells are escaped', () => {
    expect(serializeCsvHeader(['a', 'b,c'])).toBe('a,"b,c"');
  });
});

describe('streamCsv — output shape', () => {
  it('emits a BOM, a header row and every data row', async () => {
    const { fetch } = pagerOver(sample);
    const out = await collectCsvStream(streamCsv(fetch, { headers: HEADERS }));

    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out).toContain(`id,action,resource${CSV_ROW_SEPARATOR}`);
    expect(out).toContain('3,PR Comment Posted,acme/api#2');
  });

  it('omits the BOM when asked', async () => {
    const { fetch } = pagerOver(sample);
    const out = await collectCsvStream(streamCsv(fetch, { headers: HEADERS, withBom: false }));

    expect(out.startsWith(CSV_BOM)).toBe(false);
    expect(out.startsWith('id,action,resource')).toBe(true);
  });

  it('emits a header-only document for an empty source', async () => {
    // The route used to 404 here, so a fresh install clicking Export got an
    // error dialog for the correct state of "nothing has happened yet".
    const { fetch } = pagerOver([]);
    const out = await collectCsvStream(streamCsv(fetch, { headers: HEADERS, withBom: false }));

    expect(out).toBe(`id,action,resource${CSV_ROW_SEPARATOR}`);
  });

  it('separates records with CRLF, as RFC 4180 requires', async () => {
    const { fetch } = pagerOver(sample);
    const out = await collectCsvStream(streamCsv(fetch, { headers: HEADERS, withBom: false }));

    expect(out.split(CSV_ROW_SEPARATOR).filter(Boolean)).toHaveLength(4); // header + 3
  });
});

/**
 * The regression that matters: if the two paths disagree, one of them is
 * quoting — or neutralising — differently from the other.
 */
describe('streamCsv agrees with toCsv byte for byte', () => {
  it.each([
    ['plain rows', sample],
    [
      'rows needing quoting',
      [
        { id: '1', action: 'a,b', resource: 'line\nbreak' },
        { id: '2', action: 'say "hi"', resource: 'carriage\rreturn' },
      ],
    ],
    [
      'rows needing formula neutralisation',
      [
        { id: '1', action: '=cmd|\'/c calc\'!A1', resource: '+1234' },
        { id: '2', action: '-5', resource: '@SUM(A1)' },
      ],
    ],
    [
      'rows with absent and non-string values',
      [
        { id: 1, action: null, resource: undefined },
        { id: '2', action: { nested: true }, resource: new Date('2026-01-01T00:00:00.000Z') },
      ],
    ],
  ])('%s', async (_name, rows) => {
    const { fetch } = pagerOver(rows as CsvRow[]);
    const streamed = await collectCsvStream(streamCsv(fetch, { headers: HEADERS }));
    const buffered = toCsv(rows as CsvRow[], { headers: HEADERS });

    // toCsv joins records and does not terminate the last one; the stream
    // terminates every record, which is also valid RFC 4180. Compare on the
    // records themselves.
    expect(streamed.trimEnd()).toBe(buffered.trimEnd());
  });
});

describe('streamCsv — paging', () => {
  it('makes one round trip per batch rather than one per row', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: String(i), action: 'a', resource: 'r' }));
    const { fetch, calls } = pagerOver(rows);

    await collectCsvStream(streamCsv(fetch, { headers: HEADERS, batchSize: 100 }));

    // 3 full-ish pages; the third is short, which ends the stream without a
    // fourth round trip.
    expect(calls()).toBe(3);
  });

  it('stops at maxRows and does not over-fetch on the last page', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), action: 'a', resource: 'r' }));
    const takes: number[] = [];

    const fetch: CsvPageFetcher<number> = async (cursor, take) => {
      takes.push(take);
      const start = cursor ?? 0;
      const page = rows.slice(start, start + take);
      return { rows: page, nextCursor: start + page.length };
    };

    const out = await collectCsvStream(
      streamCsv(fetch, { headers: HEADERS, batchSize: 40, maxRows: 50, withBom: false }),
    );

    expect(takes).toEqual([40, 10]);
    expect(out.split(CSV_ROW_SEPARATOR).filter(Boolean)).toHaveLength(51); // header + 50
  });

  it('ends immediately when the fetcher returns a null cursor', async () => {
    const fetch = vi.fn<CsvPageFetcher<number>>(async () => ({
      rows: [{ id: '1', action: 'a', resource: 'r' }],
      nextCursor: null,
    }));

    await collectCsvStream(streamCsv(fetch, { headers: HEADERS }));

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports the row count once, on completion', async () => {
    const onComplete = vi.fn();
    const { fetch } = pagerOver(sample);

    await collectCsvStream(streamCsv(fetch, { headers: HEADERS, onComplete }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(3);
  });

  it('defaults to a sane batch size', () => {
    expect(DEFAULT_CSV_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_CSV_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });
});

describe('streamCsv — failure', () => {
  it('errors the stream rather than appending an apology to the CSV', async () => {
    // A partial file that explains itself in its own last row is a file some
    // importer will parse as data.
    const boom = new Error('connection reset');
    const fetch: CsvPageFetcher<number> = async () => {
      throw boom;
    };

    await expect(collectCsvStream(streamCsv(fetch, { headers: HEADERS }))).rejects.toThrow(
      'connection reset',
    );
  });

  it('does not keep calling the fetcher after it throws', async () => {
    const fetch = vi.fn<CsvPageFetcher<number>>(async () => {
      throw new Error('nope');
    });

    await collectCsvStream(streamCsv(fetch, { headers: HEADERS })).catch(() => undefined);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
