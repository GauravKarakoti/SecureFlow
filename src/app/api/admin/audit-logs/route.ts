import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { AuditSanitizer } from '../../../../lib/audit/auditSanitizer';

const prisma = new PrismaClient();

export async function GET(request: Request) {
  try {
    const logs = await prisma.auditEventLedger.findMany({
      orderBy: { timestamp: 'desc' },
      take: 100, // Pagination can be added
    });

    const sanitizedLogs = logs.map(log => ({
      ...log,
      payload: AuditSanitizer.deserializePayload(JSON.stringify(log.payload)),
    }));

    return NextResponse.json(sanitizedLogs);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
