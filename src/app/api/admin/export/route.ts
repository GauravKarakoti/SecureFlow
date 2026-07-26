import { NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";

export const GET = withErrorHandler(async () => {
  const session = await auth();

  // Verify session and ADMIN role
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new AppError("Unauthorized access", 401);
  }

  // Fetch all audit logs
  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' }
  });

  // Format as CSV
  if (logs.length === 0) {
    throw new AppError("No data available", 404);
  }

  const headers = ["id", "userId", "action", "resource", "decision", "metadata", "timestamp"];
  
  const csvRows = logs.map((log: any) => {
    return headers.map(header => {
      let val = (log as any)[header];
      if (typeof val === 'object' && val !== null) {
        val = JSON.stringify(val);
      }
      if (val === null || val === undefined) {
        val = "";
      }
      let stringVal = String(val);
      if (stringVal.includes(',') || stringVal.includes('"') || stringVal.includes('\n')) {
        stringVal = `"${stringVal.replace(/"/g, '""')}"`;
      }
      return stringVal;
    }).join(',');
  });

  const csvContent = [headers.join(','), ...csvRows].join('\n');

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="audit_logs_export.csv"',
    },
  });
});

