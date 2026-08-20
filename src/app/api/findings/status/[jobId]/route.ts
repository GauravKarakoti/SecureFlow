import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(
  request: Request,
  { params }: { params: { jobId: string } }
) {
  try {
    const job = await prisma.scanJob.findUnique({
      where: { id: params.jobId }
    });

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const progress = job.totalFiles > 0 
      ? Math.round((job.scannedFiles / job.totalFiles) * 100) 
      : 0;

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      scannedFiles: job.scannedFiles,
      totalFiles: job.totalFiles,
      progress,
      vulnerabilitiesFound: job.vulnerabilitiesFound
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
