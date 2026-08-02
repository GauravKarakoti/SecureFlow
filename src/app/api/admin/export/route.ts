import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";

async function handler() {
  try {
    const session = await auth();

    // Verify session and ADMIN role
    if (!session?.user || !session.user.roles?.includes("ADMIN")) {
      return NextResponse.json({ error: "Unauthorized access" }, { status: 401 });
    }

    // Fetch all audit logs
    const logs = await prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' }
    });

    // Format as CSV
    if (logs.length === 0) {
      return new NextResponse("No data available", { status: 404 });
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

  } catch (error) {
    console.error("Export Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export const GET = withRateLimit(
  handler as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: 'admin:export' }
);
