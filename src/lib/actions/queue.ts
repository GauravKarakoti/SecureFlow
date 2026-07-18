"use server";

import { webhookQueue, webhookDLQ, addWebhookJob } from '@/lib/queue/webhookQueue';
import { auth } from '@/auth';
import { revalidatePath } from 'next/cache';

export async function getQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const counts = await webhookQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  const dlqCounts = await webhookDLQ.getJobCounts('waiting');
  
  return {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    completed: counts.completed || 0,
    failed: dlqCounts.waiting || 0,
    delayed: counts.delayed || 0,
  };
}

export async function getDLQJobs() {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const jobs = await webhookDLQ.getJobs(['waiting']);
  return jobs.map((job) => ({
    id: job.id!,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
  }));
}

export async function requeueDLQJob(jobId: string) {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const job = await webhookDLQ.getJob(jobId);
  if (!job) {
    throw new Error("Job not found in DLQ");
  }

  // Re-add to main queue
  await addWebhookJob(job.data.data);
  
  // Remove from DLQ
  await job.remove();

  revalidatePath('/admin/queue');
  return { success: true };
}

export async function deleteDLQJob(jobId: string) {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const job = await webhookDLQ.getJob(jobId);
  if (!job) {
    throw new Error("Job not found in DLQ");
  }

  await job.remove();

  revalidatePath('/admin/queue');
  return { success: true };
}

export async function clearAllDLQ() {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const jobs = await webhookDLQ.getJobs(['waiting']);
  for (const job of jobs) {
    await job.remove();
  }

  revalidatePath('/admin/queue');
  return { success: true };
}

export async function requeueAllDLQ() {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const jobs = await webhookDLQ.getJobs(['waiting']);
  for (const job of jobs) {
    await addWebhookJob(job.data.data);
    await job.remove();
  }

  revalidatePath('/admin/queue');
  return { success: true };
}
