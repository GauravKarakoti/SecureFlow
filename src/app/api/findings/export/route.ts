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
import {
  buildFindingsWhere,
  fromSearchParams,
  groupFingerprintsByStatus,
  type FindingStatus,
} from "@/lib/findings/query";
import { getUserTriage, triageKey, type TriageEntry } from "@/lib/triage/queries";

/** Column order of the export. The same columns the client-side export wrote. */
export const FINDINGS_EXPORT_COLUMNS = [
  "id",
  "severity",
  "type",
  "file",
  "lineStart",
  "lineEnd",
  "repository",
  "pullRequest",
  "status",
  "remediation",
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
): Record<string, unknown> {
  if (!cursor) return filter;

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

/** One finding (as loaded below) → one CSV row. */
export function toFindingsExportRow(
  finding: any,
  byKey: Map<string, TriageEntry>,
): Record<(typeof FINDINGS_EXPORT_COLUMNS)[number], unknown> {
  const pullRequest = finding.scanResult?.pullRequest;
  const repositoryId = pullRequest?.repositoryId;
  const triage = repositoryId ? byKey.get(triageKey(repositoryId, finding.fingerprint)) : undefined;

  return {
    id: finding.id,
    severity: finding.severity,
    type: finding.type,
    file: finding.fileLocation,
    lineStart: finding.lineStart ?? "",
    lineEnd: finding.lineEnd ?? "",
    repository: pullRequest?.repository?.fullName ?? "",
    pullRequest: pullRequest?.prNumber ?? "",
    status: (triage?.status as FindingStatus | undefined) ?? "OPEN",
    remediation: finding.remediation ?? "",
    createdAt: new Date(finding.createdAt).toISOString(),
  };
}

/** `secureflow-findings-2026-09-22.csv` — the name the client-side export used. */
export function findingsExportFilename(now: Date = new Date()): string {
  return `secureflow-findings-${now.toISOString().slice(0, 10)}.csv`;
}

async function handler(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }

  const userId = session.user.id;
  const query = fromSearchParams(searchParamsToRecord(req.nextUrl.searchParams));

  const { suppressedFingerprints, byKey } = await getUserTriage(userId);
  const filter = buildFindingsWhere(
    {
      userId,
      dismissedFingerprints: suppressedFingerprints,
      fingerprintsByStatus: groupFingerprintsByStatus(byKey),
    },
    query,
  );

  const body = streamCsv<FindingsExportCursor>(
    async (cursor, take) => {
      const rows = await prisma.finding.findMany({
        where: buildExportPageWhere(filter, cursor),
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
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

      return {
        rows: rows.map((row: any) => toFindingsExportRow(row, byKey)),
        nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    },
    {
      headers: [...FINDINGS_EXPORT_COLUMNS],
      batchSize: FINDINGS_EXPORT_BATCH_SIZE,
      maxRows: MAX_FINDINGS_EXPORT_ROWS,
    },
  );

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${findingsExportFilename()}"`,
      "Cache-Control": "no-store",
      "X-Export-Limit": String(MAX_FINDINGS_EXPORT_ROWS),
    },
  });
}

export const GET = withRateLimit(
  withErrorHandler(handler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "findings:export" },
);

export const dynamic = "force-dynamic";
