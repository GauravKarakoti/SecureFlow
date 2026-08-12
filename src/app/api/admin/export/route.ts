import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { toCsv } from "@/lib/utils/csv";

/** Column order of the export. Fixed rather than derived so the file shape is stable. */
export const AUDIT_LOG_EXPORT_COLUMNS = [
  "id",
  "userId",
  "action",
  "resource",
  "decision",
  "metadata",
  "timestamp",
] as const;

async function handler() {
  const session = await auth();

  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new AppError("Unauthorized access", 401);
  }

  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' }
  });

  if (logs.length === 0) {
    throw new AppError("No data available", 404);
  }

  // Serialisation (quoting, CRLF records, BOM and formula-injection neutralisation)
  // is shared with the client-side download helper so both paths emit the same bytes.
  const csvContent = toCsv(logs as Array<Record<string, unknown>>, {
    headers: [...AUDIT_LOG_EXPORT_COLUMNS],
  });

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      // The charset is explicit so the BOM is interpreted rather than shown as
      // stray characters in the first header cell.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit_logs_export.csv"',
      // Audit data must never be cached by an intermediary.
      'Cache-Control': 'no-store',
    },
  });
}

export const GET = withRateLimit(
  withErrorHandler(handler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: 'admin:export' }
);
