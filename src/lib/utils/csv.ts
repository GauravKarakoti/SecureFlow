/**
 * RFC 4180 CSV serialisation with spreadsheet formula-injection defence.
 *
 * Audit log rows are populated from GitHub webhook payloads, so their contents are
 * attacker-influenced: a repository can be named `=cmd|'/c calc'!A1` and that string
 * lands verbatim in the `resource` column. Excel, LibreOffice and Google Sheets all
 * evaluate a cell that begins with a formula trigger character, which turns a plain
 * data export into code execution on the reviewer's machine (CWE-1236).
 *
 * Everything in this module is pure so it can be shared by the client-side download
 * helper and the server-side `/api/admin/export` route, which previously carried two
 * separate hand-rolled copies of the same quoting logic.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than as text.
 *
 * `=` and `+` start a formula outright. `-` starts one when followed by a number or
 * reference. `@` introduces an intersection/lambda in newer Excel builds. A leading
 * TAB or CR is stripped by some importers, exposing whichever character follows it,
 * so they are treated as triggers too.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'] as const;

/** Prefix that forces text interpretation while remaining visible-ish to the reader. */
const NEUTRALISING_PREFIX = "'";

/** RFC 4180 mandates CRLF between records. */
export const CSV_ROW_SEPARATOR = '\r\n';

/**
 * Byte-order mark. Excel on Windows assumes the host ANSI code page for a BOM-less
 * file, which renders any non-ASCII repository name or codename as mojibake.
 */
export const CSV_BOM = '﻿';

export interface CsvOptions {
  /**
   * Explicit column order. When omitted the header row is the union of the keys of
   * every row, in first-seen order, so a key that is absent from the first row is
   * still exported.
   */
  headers?: string[];
  /** Prepend a UTF-8 BOM. Defaults to true. */
  withBom?: boolean;
}

/**
 * Convert an arbitrary cell value into its string form before quoting.
 *
 * Objects and arrays (e.g. the audit log `metadata` column) are JSON-encoded; null
 * and undefined become the empty string. `Date` is handled explicitly because the
 * default `JSON.stringify` of a bare Date inside an object differs from what you get
 * when stringifying it directly.
 */
export function stringifyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      // Circular structures fall back to a plain coercion rather than throwing and
      // taking down the whole export.
      return String(value);
    }
  }
  return String(value);
}

/**
 * Return true when `value` would be interpreted as a formula by spreadsheet software.
 *
 * The check is applied to the raw value, before quoting: wrapping a cell in double
 * quotes is a CSV-level construct that importers strip, so it provides no protection
 * on its own.
 */
export function isFormulaInjection(value: string): boolean {
  if (!value) return false;
  return FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger));
}

/**
 * Neutralise a single value and apply RFC 4180 quoting.
 *
 * Order matters: neutralisation happens first so the apostrophe is inside the quoted
 * field rather than outside it.
 */
export function escapeCsvCell(value: unknown): string {
  let text = stringifyCsvValue(value);

  if (isFormulaInjection(text)) {
    text = `${NEUTRALISING_PREFIX}${text}`;
  }

  // `\r` is included deliberately: a lone carriage return inside an unquoted field
  // terminates the record for most parsers and corrupts every subsequent column.
  const needsQuoting =
    text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r');

  if (!needsQuoting) return text;

  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Build the header row for `rows`.
 *
 * Using only `Object.keys(rows[0])` silently drops any column that the first row
 * happens not to carry — a real hazard for audit logs, where `decision` is null for
 * informational entries and may legitimately be absent from the newest row.
 */
export function collectCsvHeaders(rows: Array<Record<string, unknown>>): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  return headers;
}

/**
 * Serialise `rows` to a complete CSV document.
 *
 * Returns an empty string for an empty input so callers can cheaply decide whether
 * there is anything worth downloading.
 */
export function toCsv(rows: Array<Record<string, unknown>>, options: CsvOptions = {}): string {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const headers = options.headers ?? collectCsvHeaders(rows);
  if (headers.length === 0) return '';

  const lines: string[] = [headers.map(escapeCsvCell).join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvCell(row?.[header])).join(','));
  }

  const body = lines.join(CSV_ROW_SEPARATOR);
  return options.withBom === false ? body : `${CSV_BOM}${body}`;
}
