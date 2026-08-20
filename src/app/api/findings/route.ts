import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { ScanQueue } from '../../../lib/queue/scanQueue';
import { globalWorkerPool } from '../../../lib/queue/workerPool';

const prisma = new PrismaClient();
const queue = ScanQueue.getInstance();

export async function POST(request: Request) {
  try {
    const { repositoryId } = await request.json();

    if (!repositoryId) {
      return NextResponse.json({ error: 'Repository ID is required' }, { status: 400 });
    }

    // Ensure worker pool is started
    globalWorkerPool.start();

    const job = await prisma.scanJob.create({
      data: {
        repositoryId,
        status: 'PENDING'
      }
    });

    await queue.addJob(job.id, repositoryId);

    return NextResponse.json({ 
      success: true, 
      message: 'Scan job queued successfully',
      jobId: job.id
    }, { status: 202 });
    
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
