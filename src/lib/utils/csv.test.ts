import { describe, it, expect } from 'vitest';
import {
  CSV_BOM,
  CSV_ROW_SEPARATOR,
  collectCsvHeaders,
  escapeCsvCell,
  isFormulaInjection,
  stringifyCsvValue,
  toCsv,
} from './csv';

describe('stringifyCsvValue', () => {
  it('renders null and undefined as an empty string', () => {
    expect(stringifyCsvValue(null)).toBe('');
    expect(stringifyCsvValue(undefined)).toBe('');
  });

  it('renders primitives via String()', () => {
    expect(stringifyCsvValue('hello')).toBe('hello');
    expect(stringifyCsvValue(42)).toBe('42');
    expect(stringifyCsvValue(false)).toBe('false');
    expect(stringifyCsvValue(0)).toBe('0');
  });

  it('JSON-encodes objects and arrays', () => {
    expect(stringifyCsvValue({ count: 2 })).toBe('{"count":2}');
    expect(stringifyCsvValue(['a', 'b'])).toBe('["a","b"]');
  });

  it('renders Date values as ISO strings', () => {
    expect(stringifyCsvValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('does not throw on circular structures', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => stringifyCsvValue(circular)).not.toThrow();
  });
});

describe('isFormulaInjection', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('flags a value starting with %j', (trigger) => {
    expect(isFormulaInjection(`${trigger}SUM(A1:A9)`)).toBe(true);
  });

  it('does not flag ordinary values', () => {
    expect(isFormulaInjection('owner/repo#12')).toBe(false);
    expect(isFormulaInjection('Scan Triggered')).toBe(false);
    expect(isFormulaInjection('')).toBe(false);
  });

  it('does not flag a trigger character that appears mid-value', () => {
    expect(isFormulaInjection('total=5')).toBe(false);
    expect(isFormulaInjection('user@example.com')).toBe(false);
  });
});

describe('escapeCsvCell', () => {
  it('neutralises the classic DDE payload', () => {
    // Without the leading apostrophe Excel would execute this on open.
    // Apostrophes are not CSV-special, so the field needs no surrounding quotes.
    expect(escapeCsvCell(`=cmd|'/c calc'!A1`)).toBe(`'=cmd|'/c calc'!A1`);
  });

  it('neutralises every formula trigger', () => {
    expect(escapeCsvCell('=1+1')).toBe(`'=1+1`);
    expect(escapeCsvCell('+1')).toBe(`'+1`);
    expect(escapeCsvCell('-1')).toBe(`'-1`);
    expect(escapeCsvCell('@SUM')).toBe(`'@SUM`);
  });

  it('quotes values containing a comma', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values containing a bare carriage return', () => {
    // The pre-fix implementation only triggered on \n, so a lone \r corrupted the row.
    expect(escapeCsvCell('line1\rline2')).toBe('"line1\rline2"');
  });

  it('quotes values containing a newline', () => {
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('leaves ordinary values untouched', () => {
    expect(escapeCsvCell('Policy Evaluation')).toBe('Policy Evaluation');
  });

  it('renders empty values as an empty field', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('neutralises before quoting so the apostrophe stays inside the field', () => {
    const escaped = escapeCsvCell('=A1,B2');
    expect(escaped).toBe(`"'=A1,B2"`);
    expect(escaped.startsWith('"')).toBe(true);
  });
});

describe('collectCsvHeaders', () => {
  it('returns the union of keys across all rows', () => {
    const headers = collectCsvHeaders([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }]);
    expect(headers).toEqual(['a', 'b', 'c']);
  });

  it('preserves first-seen order', () => {
    expect(collectCsvHeaders([{ z: 1, a: 2 }])).toEqual(['z', 'a']);
  });

  it('ignores non-object rows', () => {
    expect(collectCsvHeaders([null as never, { a: 1 }])).toEqual(['a']);
  });

  it('returns an empty array for no rows', () => {
    expect(collectCsvHeaders([])).toEqual([]);
  });
});

describe('toCsv', () => {
  const rows = [
    { action: 'Scan Triggered', resource: 'acme/api#12', decision: null },
    { action: 'Policy Evaluation', resource: 'acme/api#12', decision: 'BLOCK' },
  ];

  it('emits a BOM by default', () => {
    expect(toCsv(rows).startsWith(CSV_BOM)).toBe(true);
  });

  it('omits the BOM when asked', () => {
    const csv = toCsv(rows, { withBom: false });
    expect(csv.startsWith(CSV_BOM)).toBe(false);
    expect(csv.startsWith('action,resource,decision')).toBe(true);
  });

  it('separates records with CRLF', () => {
    const csv = toCsv(rows, { withBom: false });
    expect(csv.split(CSV_ROW_SEPARATOR)).toHaveLength(3);
  });

  it('writes the header row followed by one row per record', () => {
    const lines = toCsv(rows, { withBom: false }).split(CSV_ROW_SEPARATOR);
    expect(lines[0]).toBe('action,resource,decision');
    expect(lines[1]).toBe('Scan Triggered,acme/api#12,');
    expect(lines[2]).toBe('Policy Evaluation,acme/api#12,BLOCK');
  });

  it('honours an explicit header order and ignores unlisted keys', () => {
    const csv = toCsv([{ b: 2, a: 1, ignored: 'x' }], { headers: ['a', 'b'], withBom: false });
    expect(csv).toBe(`a,b${CSV_ROW_SEPARATOR}1,2`);
  });

  it('emits empty fields for headers a row is missing', () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }], { withBom: false });
    expect(csv).toBe(`a,b${CSV_ROW_SEPARATOR}1,${CSV_ROW_SEPARATOR},2`);
  });

  it('returns an empty string for empty or invalid input', () => {
    expect(toCsv([])).toBe('');
    expect(toCsv(null as never)).toBe('');
    expect(toCsv([{}])).toBe('');
  });

  it('neutralises a formula smuggled through a data row', () => {
    const csv = toCsv([{ resource: '=HYPERLINK("http://evil","click")' }], { withBom: false });
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
  });

  it('neutralises a formula smuggled through a column name', () => {
    const csv = toCsv([{ '=cmd': 'value' }], { withBom: false });
    expect(csv.split(CSV_ROW_SEPARATOR)[0]).toBe(`'=cmd`);
  });

  it('keeps a multiline value inside a single quoted field', () => {
    const csv = toCsv([{ note: 'first\nsecond' }], { withBom: false });
    expect(csv).toBe(`note${CSV_ROW_SEPARATOR}"first\nsecond"`);
  });

  it('serialises object columns such as audit log metadata', () => {
    const csv = toCsv([{ metadata: { count: 3, event: 'installation' } }], { withBom: false });
    expect(csv).toContain('"{""count"":3,""event"":""installation""}"');
  });
});
