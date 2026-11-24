/**
 * GET /api/findings/export — every finding matching the dashboard's filters, as CSV.
 *
 * The Security Findings "Export CSV" button used to serialise `findings`, the
 * rows already in the browser. That is one page (20 by default, 100 at most),
 * while the badge next to the button reads the filtered total — so an account
 * with 340 findings got a 20-row file with no hint that 320 were missing.
 *
 * This route takes the same query string as `/dashboard/findings`, builds the
 * same `where` through `buildFindingsWhere`, and streams every matching row
 * through `streamCsv`, the serialiser behind `/api/admin/export`. Dismissed
 * findings are left out exactly as the list leaves them out, and the triage
 * status column is resolved the same way the list resolves it.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { streamCsv } from "@/lib/utils/csv-stream";
import { exportResponse } from "@/lib/utils/export-response";
import {
  buildFindingsWhere,
  fromSearchParams,
  groupFingerprintsByStatus,
  type FindingSort,
  type FindingStatus,
} from "@/lib/findings/query";
import { STORED_SEVERITIES } from "@/lib/severity";
import { getUserTriage, triageKey, type TriageEntry } from "@/lib/triage/queries";
import {
  generateShareableReportHtml,
  type ShareableReportFinding,
} from "@/lib/reports/shareable-report";

/** Column order of the export. The same columns the client-side export wrote, plus title and line. */
export const FINDINGS_EXPORT_COLUMNS = [
  "id",
  "title",
  "severity",
  "status",
  "file",
  "line",
  "cwe",
  "remediation",
  "type",
  "lineStart",
  "lineEnd",
  "repository",
  "pullRequest",
  "createdAt",
] as const;

/** Rows per database round trip. */
export const FINDINGS_EXPORT_BATCH_SIZE = 500;

/**
 * Ceiling on rows a single export may emit, so the response always terminates.
 * Stated in the `X-Export-Limit` header rather than applied silently.
 */
export const MAX_FINDINGS_EXPORT_ROWS = 50_000;

/** Keyset position. `createdAt` is not unique, so `id` breaks the tie. */
export interface FindingsExportCursor {
  createdAt: Date;
  id: string;
  fileLocation?: string;
  severityIndex?: number;
}

/**
 * `URLSearchParams` → the record shape `fromSearchParams` reads.
 *
 * Repeated keys (`?severity=HIGH&severity=CRITICAL`) stay arrays, which is how
 * the page receives them from Next.
 */
export function searchParamsToRecord(params: URLSearchParams): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    record[key] = values.length > 1 ? values : values[0];
  }

  return record;
}

/** Prisma `orderBy` clause matching the active sort. */
export function getExportOrderBy(sort: FindingSort): Record<string, "asc" | "desc">[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "file":
      return [{ fileLocation: "asc" }, { createdAt: "desc" }, { id: "asc" }];
    case "severity":
    case "newest":
    default:
      return [{ createdAt: "desc" }, { id: "asc" }];
  }
}

/**
 * The `where` for one page: the dashboard's filter, then "after the cursor".
 *
 * Combined through `AND` rather than spread, because the filter may already
 * carry an `OR` (the status filter, the search) that the cursor's `OR` would
 * otherwise overwrite.
 */
export function buildExportPageWhere(
  filter: Record<string, unknown>,
  cursor: FindingsExportCursor | null,
  sort: FindingSort = "newest",
): Record<string, unknown> {
  if (!cursor) return filter;

  if (sort === "oldest") {
    return {
      AND: [
        filter,
        {
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        },
      ],
    };
  }

  if (sort === "file" && cursor.fileLocation !== undefined) {
    return {
      AND: [
        filter,
        {
          OR: [
            { fileLocation: { gt: cursor.fileLocation } },
            {
              fileLocation: cursor.fileLocation,
              createdAt: { lt: cursor.createdAt },
            },
            {
              fileLocation: cursor.fileLocation,
              createdAt: cursor.createdAt,
              id: { gt: cursor.id },
            },
          ],
        },
      ],
    };
  }

  // Ordering is `createdAt desc, id asc`, so "after the cursor" means an older
  // row, or one created at the same instant with a higher id.
  return {
    AND: [
      filter,
      {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
    ],
  };
}

/** One finding (as loaded below) → one export row. */
export function toFindingsExportRow(
  finding: any,
  byKey: Map<string, TriageEntry>,
): Record<(typeof FINDINGS_EXPORT_COLUMNS)[number], unknown> {
  const pullRequest = finding.scanResult?.pullRequest;
  const repositoryId = pullRequest?.repositoryId;
  const triage = repositoryId ? byKey.get(triageKey(repositoryId, finding.fingerprint)) : undefined;

  const rawTitle = finding.title ?? (finding.type ? `${finding.type} Detected` : "");

  return {
    id: finding.id,
    title: rawTitle,
    severity: finding.severity,
    status: (triage?.status as FindingStatus | undefined) ?? "OPEN",
    file: finding.fileLocation,
    line: finding.lineStart ?? "",
    cwe: finding.cwe ?? "",
    remediation: finding.remediation ?? "",
    type: finding.type,
    lineStart: finding.lineStart ?? "",
    lineEnd: finding.lineEnd ?? "",
    repository: pullRequest?.repository?.fullName ?? "",
    pullRequest: pullRequest?.prNumber ?? "",
    createdAt: new Date(finding.createdAt).toISOString(),
  };
}

/** `secureflow-findings-2026-09-22.csv` — CSV filename. */
export function findingsExportFilename(now: Date = new Date()): string {
  return `secureflow-findings-${now.toISOString().slice(0, 10)}.csv`;
}

/** `secureflow-findings-2026-09-22.json` — JSON filename. */
export function findingsJsonExportFilename(now: Date = new Date()): string {
  return `secureflow-findings-${now.toISOString().slice(0, 10)}.json`;
}

/** `secureflow-security-report-2026-09-22.html` — formatted shareable HTML report filename. */
export function findingsReportFilename(now: Date = new Date()): string {
  return `secureflow-security-report-${now.toISOString().slice(0, 10)}.html`;
}

/**
 * Fetch a single batch of export rows, applying active filters and sorting.
 */
export async function fetchExportBatch(
  cursor: FindingsExportCursor | null,
  take: number,
  filter: Record<string, unknown>,
  sort: FindingSort,
  byKey: Map<string, TriageEntry>,
): Promise<{
  rows: Record<(typeof FINDINGS_EXPORT_COLUMNS)[number], unknown>[];
  nextCursor: FindingsExportCursor | null;
}> {
  if (sort === "severity") {
    const accumulatedRows: any[] = [];
    let currentBucketIndex = cursor?.severityIndex ?? 0;
    let currentSubCursor: FindingsExportCursor | null = cursor
      ? { createdAt: cursor.createdAt, id: cursor.id }
      : null;

    while (accumulatedRows.length < take && currentBucketIndex < STORED_SEVERITIES.length) {
      const severity = STORED_SEVERITIES[currentBucketIndex];
      const remaining = take - accumulatedRows.length;
      const bucketFilter: Record<string, unknown> = {
        ...filter,
        severity,
      };
      const bucketWhere = buildExportPageWhere(bucketFilter, currentSubCursor, "newest");

      const batch = await prisma.finding.findMany({
        where: bucketWhere,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: remaining,
        include: {
          scanResult: {
            include: {
              pullRequest: {
                include: { repository: { select: { id: true, fullName: true } } },
              },
            },
          },
        },
      });

      accumulatedRows.push(...batch);

      if (batch.length < remaining) {
        currentBucketIndex++;
        currentSubCursor = null;
      } else {
        const last = batch[batch.length - 1];
        currentSubCursor = { createdAt: last.createdAt, id: last.id };
        break;
      }
    }

    if (accumulatedRows.length === 0) {
      return { rows: [], nextCursor: null };
    }

    const last = accumulatedRows[accumulatedRows.length - 1];
    const nextCursor: FindingsExportCursor | null =
      currentBucketIndex < STORED_SEVERITIES.length
        ? {
            createdAt: last.createdAt,
            id: last.id,
            severityIndex: currentBucketIndex,
          }
        : null;

    return {
      rows: accumulatedRows.map((row: any) => toFindingsExportRow(row, byKey)),
      nextCursor,
    };
  }

  const rows = await prisma.finding.findMany({
    where: buildExportPageWhere(filter, cursor, sort),
    orderBy: getExportOrderBy(sort),
    take,
    include: {
      scanResult: {
        include: {
          pullRequest: {
            include: { repository: { select: { id: true, fullName: true } } },
          },
        },
      },
    },
  });

  const last = rows[rows.length - 1];
  const nextCursor: FindingsExportCursor | null = last
    ? {
        createdAt: last.createdAt,
        id: last.id,
        fileLocation: last.fileLocation,
      }
    : null;

  return {
    rows: rows.map((row: any) => toFindingsExportRow(row, byKey)),
    nextCursor,
  };
}

/**
 * Stream findings rows as a JSON array (`[...]`), preventing memory exhaustion
 * and freezing on large exports.
 */
export function streamJson<TCursor>(
  fetchPage: (
    cursor: TCursor | null,
    take: number,
  ) => Promise<{
    rows: Record<string, unknown>[];
    nextCursor: TCursor | null;
  }>,
  options: {
    batchSize?: number;
    maxRows?: number;
    onComplete?: (rowCount: number) => void;
  } = {},
): ReadableStream<Uint8Array> {
  const {
    batchSize = FINDINGS_EXPORT_BATCH_SIZE,
    maxRows = MAX_FINDINGS_EXPORT_ROWS,
    onComplete,
  } = options;

  const encoder = new TextEncoder();
  let cursor: TCursor | null = null;
  let emitted = 0;
  let started = false;
  let done = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;

      try {
        const remaining = maxRows - emitted;
        if (remaining <= 0) {
          done = true;
          if (!started) {
            controller.enqueue(encoder.encode("[]\n"));
          } else {
            controller.enqueue(encoder.encode("\n]\n"));
          }
          onComplete?.(emitted);
          controller.close();
          return;
        }

        const take = Math.min(batchSize, remaining);
        const page = await fetchPage(cursor, take);
        const rows = page.rows ?? [];

        if (rows.length === 0) {
          done = true;
          if (!started) {
            controller.enqueue(encoder.encode("[]\n"));
          } else {
            controller.enqueue(encoder.encode("\n]\n"));
          }
          onComplete?.(emitted);
          controller.close();
          return;
        }

        const chunks: string[] = [];
        for (let i = 0; i < rows.length; i++) {
          if (!started && i === 0) {
            chunks.push(`[\n  ${JSON.stringify(rows[i])}`);
          } else {
            chunks.push(`,\n  ${JSON.stringify(rows[i])}`);
          }
        }
        started = true;
        controller.enqueue(encoder.encode(chunks.join("")));

        emitted += rows.length;
        cursor = page.nextCursor;

        if (page.nextCursor === null || rows.length < take || emitted >= maxRows) {
          done = true;
          controller.enqueue(encoder.encode("\n]\n"));
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

async function handler(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }

  const userId = session.user.id;
  const searchRecord = searchParamsToRecord(req.nextUrl.searchParams);
  const query = fromSearchParams(searchRecord);
  const sort = query.sort;

  const { suppressedFingerprints, byKey } = await getUserTriage(userId);
  const filter = buildFindingsWhere(
    {
      userId,
      dismissedFingerprints: suppressedFingerprints,
      fingerprintsByStatus: groupFingerprintsByStatus(byKey),
    },
    query,
  );

  const format = req.nextUrl.searchParams.get("format")?.toLowerCase();

  // Shareable HTML / printable report export
  if (format === "html" || format === "pdf") {
    let rows: any[] = [];
    if (sort === "severity") {
      const buckets = await Promise.all(
        STORED_SEVERITIES.map((severity) =>
          prisma.finding.findMany({
            where: { ...filter, severity },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            take: MAX_FINDINGS_EXPORT_ROWS,
            include: {
              scanResult: {
                include: {
                  pullRequest: {
                    include: { repository: { select: { id: true, fullName: true } } },
                  },
                },
              },
            },
          }),
        ),
      );
      rows = buckets.flat().slice(0, MAX_FINDINGS_EXPORT_ROWS);
    } else {
      rows = await prisma.finding.findMany({
        where: filter,
        orderBy: getExportOrderBy(sort),
        take: MAX_FINDINGS_EXPORT_ROWS,
        include: {
          scanResult: {
            include: {
              pullRequest: {
                include: { repository: { select: { id: true, fullName: true } } },
              },
            },
          },
        },
      });
    }

    const findings: ShareableReportFinding[] = rows.map((row: any) => {
      const exportRow = toFindingsExportRow(row, byKey);
      return {
        id: String(exportRow.id),
        severity: String(exportRow.severity),
        type: String(exportRow.type),
        fileLocation: String(exportRow.file),
        lineStart: exportRow.lineStart !== "" ? Number(exportRow.lineStart) : null,
        lineEnd: exportRow.lineEnd !== "" ? Number(exportRow.lineEnd) : null,
        repository: String(exportRow.repository),
        pullRequest: exportRow.pullRequest !== "" ? Number(exportRow.pullRequest) : null,
        status: String(exportRow.status),
        remediation: String(exportRow.remediation || ""),
        createdAt: String(exportRow.createdAt),
      };
    });

    const searchQuery = req.nextUrl.searchParams.get("q");
    const html = generateShareableReportHtml({
      findings,
      totalCount: findings.length,
      filterSummary: searchQuery ? `Query: "${searchQuery}"` : undefined,
    });

    return exportResponse(html, {
      contentType: "text/html; charset=utf-8",
      filename: findingsReportFilename(),
      limit: MAX_FINDINGS_EXPORT_ROWS,
    });
  }

  // JSON export
  if (format === "json") {
    const body = streamJson<FindingsExportCursor>(
      (cursor, take) => fetchExportBatch(cursor, take, filter, sort, byKey),
      {
        batchSize: FINDINGS_EXPORT_BATCH_SIZE,
        maxRows: MAX_FINDINGS_EXPORT_ROWS,
      },
    );

    return exportResponse(body, {
      contentType: "application/json; charset=utf-8",
      filename: findingsJsonExportFilename(),
      limit: MAX_FINDINGS_EXPORT_ROWS,
    });
  }

  // CSV export (default)
  const body = streamCsv<FindingsExportCursor>(
    (cursor, take) => fetchExportBatch(cursor, take, filter, sort, byKey),
    {
      headers: [...FINDINGS_EXPORT_COLUMNS],
      batchSize: FINDINGS_EXPORT_BATCH_SIZE,
      maxRows: MAX_FINDINGS_EXPORT_ROWS,
    },
  );

  return exportResponse(body, {
    contentType: "text/csv; charset=utf-8",
    filename: findingsExportFilename(),
    limit: MAX_FINDINGS_EXPORT_ROWS,
  });
}

export const GET = withRateLimit(
  withErrorHandler(handler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "findings:export" },
);

export const dynamic = "force-dynamic";
