import { NextResponse } from "next/server";
import { AppError } from "@/lib/middleware/error-handler";

/**
 * Shared helpers for the export routes (`/api/admin/export`,
 * `/api/compliance/export`, `/api/findings/export`).
 */

/**
 * Parse an ISO-8601 date query parameter.
 *
 * Returns `undefined` for an absent or empty value and throws for a malformed
 * one. Silently ignoring a typo would hand back a different range than the
 * caller asked for, which for an audit export is worse than an error.
 */
export function parseDateParam(raw: string | null, name: string): Date | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid \`${name}\` parameter: expected an ISO-8601 date.`, 400);
  }

  return parsed;
}

/** Parse a positive integer, clamped to `max`. */
export function parseLimitParam(raw: string | null, max: number): number | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new AppError("Invalid `limit` parameter: expected a positive integer.", 400);
  }

  return Math.min(parsed, max);
}

export interface ExportResponseOptions {
  /** Full `Content-Type`, including charset where relevant. */
  contentType: string;
  /** Download filename, without quotes. */
  filename: string;
  /** Row ceiling applied to the export, stated in `X-Export-Limit`. */
  limit?: number;
  /** Route-specific headers, e.g. `X-Export-Window`. */
  headers?: Record<string, string>;
}

/**
 * Headers every export download carries: type, attachment filename, and
 * `no-store` so intermediaries never cache exported data.
 */
export function buildExportHeaders(options: ExportResponseOptions): Record<string, string> {
  return {
    "Content-Type": options.contentType,
    "Content-Disposition": `attachment; filename="${options.filename}"`,
    "Cache-Control": "no-store",
    ...(options.limit !== undefined && { "X-Export-Limit": String(options.limit) }),
    ...options.headers,
  };
}

/** A 200 download response with the shared export headers. */
export function exportResponse(
  body: BodyInit | null,
  options: ExportResponseOptions,
): NextResponse {
  return new NextResponse(body, { status: 200, headers: buildExportHeaders(options) });
}
