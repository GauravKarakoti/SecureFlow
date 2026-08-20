/**
 * Streaming CSV serialisation, for exports too large to hold in memory.
 *
 * `toCsv` in `./csv` builds the whole document as one string. That is right for
 * the client-side download helper, where the rows are already in the browser,
 * and wrong for `/api/admin/export`, which read **every row of `AuditLog`** and
 * then held roughly three simultaneous copies of the table: the Prisma result
 * objects, the intermediate `lines: string[]` inside `toCsv`, and the joined
 * string handed to `NextResponse` (#592).
 *
 * `AuditLog` is the highest-volume table in the schema — the worker writes up
 * to four rows per pull request event and `setFindingStatus` writes one per
 * triage click — so this is an out-of-memory kill triggered by a single
 * unauthenticated-until-the-handler `GET`.
 *
 * Nothing here re-implements quoting. `escapeCsvCell` and `collectCsvHeaders`
 * are imported from `./csv`, so the streamed bytes are identical to the
 * buffered ones, formula-injection defence included. What this module adds is
 * *when* those bytes are produced.
 */

import { CSV_BOM, CSV_ROW_SEPARATOR, collectCsvHeaders, escapeCsvCell } from './csv';

export type CsvRow = Record<string, unknown>;

/**
 * Fetch one page of rows.
 *
 * `cursor` is whatever the previous call returned as `nextCursor`, and is
 * opaque to this module — the caller owns the keyset. Returning an empty `rows`
 * array, or a null `nextCursor`, ends the stream.
 */
export type CsvPageFetcher<TCursor> = (
  cursor: TCursor | null,
  take: number
) => Promise<{ rows: CsvRow[]; nextCursor: TCursor | null }>;

export interface CsvStreamOptions {
  /** Fixed column order. Required: a stream cannot see all rows before it starts. */
  headers: string[];
  /** Rows per database round trip. */
  batchSize?: number;
  /** Ceiling on rows emitted, so the response always terminates. */
  maxRows?: number;
  /** Prepend a UTF-8 BOM so Excel on Windows reads it as UTF-8. Defaults to true. */
  withBom?: boolean;
  /** Called once the stream ends, with the number of rows emitted. */
  onComplete?: (rowCount: number) => void;
}

/** Rows per round trip when the caller does not say. */
export const DEFAULT_CSV_BATCH_SIZE = 500;

/**
 * Serialise one row against a fixed header list.
 *
 * Exported because the row-level contract is the thing worth testing directly:
 * if this disagrees with `toCsv`, the two export paths emit different bytes.
 */
export function serializeCsvRow(row: CsvRow, headers: string[]): string {
  return headers.map((header) => escapeCsvCell(row?.[header])).join(',');
}

/** The header line, escaped the same way a data row is. */
export function serializeCsvHeader(headers: string[]): string {
  return headers.map(escapeCsvCell).join(',');
}

/**
 * Page through `fetchPage` and emit a complete CSV document as a stream.
 *
 * Peak memory is one batch, not one table. The header row is emitted before the
 * first fetch, so a client sees bytes immediately rather than after a
 * full-table scan — which also means a slow export no longer looks like a hung
 * request.
 *
 * An error mid-stream is surfaced by erroring the stream rather than by
 * appending an apology to the CSV: a partial file that *says* it is partial in
 * its own last row is a file that some importer will happily parse as data.
 */
export function streamCsv<TCursor>(
  fetchPage: CsvPageFetcher<TCursor>,
  options: CsvStreamOptions
): ReadableStream<Uint8Array> {
  const {
    headers,
    batchSize = DEFAULT_CSV_BATCH_SIZE,
    maxRows = Number.POSITIVE_INFINITY,
    withBom = true,
    onComplete,
  } = options;

  const encoder = new TextEncoder();
  let cursor: TCursor | null = null;
  let emitted = 0;
  let wroteHeader = false;
  let done = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;

      try {
        if (!wroteHeader) {
          wroteHeader = true;
          controller.enqueue(
            encoder.encode(
              `${withBom ? CSV_BOM : ''}${serializeCsvHeader(headers)}${CSV_ROW_SEPARATOR}`
            )
          );
          return;
        }

        // Never ask for more than the caller will accept, so the last page does
        // not read rows only to discard them.
        const remaining = maxRows - emitted;
        if (remaining <= 0) {
          done = true;
          onComplete?.(emitted);
          controller.close();
          return;
        }

        const take = Math.min(batchSize, remaining);
        const page = await fetchPage(cursor, take);
        const rows = page.rows ?? [];

        if (rows.length === 0) {
          done = true;
          onComplete?.(emitted);
          controller.close();
          return;
        }

        // One enqueue per batch rather than per row: a chunk boundary between
        // every record turns a 50k-row export into 50k stream operations.
        const chunk = rows.map((row) => serializeCsvRow(row, headers)).join(CSV_ROW_SEPARATOR);
        controller.enqueue(encoder.encode(`${chunk}${CSV_ROW_SEPARATOR}`));

        emitted += rows.length;
        cursor = page.nextCursor;

        // A short page means the source is drained; a null cursor means the
        // caller has nothing further to seek from. Either ends the stream on
        // the next pull without a wasted round trip.
        if (page.nextCursor === null || rows.length < take) {
          done = true;
          onComplete?.(emitted);
          controller.close();
        }
      } catch (error) {
        done = true;
        controller.error(error);
      }
    },
  });
}

/**
 * Collect a stream back into a string.
 *
 * For tests, and for any caller that genuinely wants the whole document —
 * keeping the "read it all" decision at the call site rather than baked into
 * the producer.
 */
export async function collectCsvStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  // `ignoreBOM: true` means "do not consume the BOM", i.e. keep it in the
  // output. The default swallows it, which would make this helper report bytes
  // the client does not actually receive — and the BOM is the entire reason
  // Excel on Windows reads the file as UTF-8 rather than as the host code page.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const reader = stream.getReader();
  let out = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

/**
 * Re-exported so a caller that needs a header list can derive one the same way
 * the buffered path does, without importing both modules.
 */
export { collectCsvHeaders };
