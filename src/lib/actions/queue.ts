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

  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return {
      waiting: 2,
      active: 1,
      completed: 15,
      failed: 0,
      delayed: 0,
    };
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

export type QueueJobState = "waiting" | "active" | "completed" | "delayed";

export async function getQueueJobs(state: QueueJobState, limit = 200) {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const jobs = await webhookQueue.getJobs([state], 0, Math.max(limit - 1, 0));
  return jobs.map((job) => ({
    id: job.id!,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    progress: job.progress ?? null,
    attemptsMade: job.attemptsMade ?? 0,
    failedReason: (job as any).failedReason ?? null,
  }));
}

export async function removeQueueJob(jobId: string, state: QueueJobState) {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  if (state === "active") {
    throw new Error("Cannot remove a job that is currently being processed");
  }

  const job = await webhookQueue.getJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  await job.remove();

  revalidatePath("/admin/queue");
  return { success: true };
}

export async function getDLQJobs() {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return [
      {
        id: "mock-dlq-1",
        name: "webhook-scan",
        data: { repository: "mock-owner/mock-repo", event: "pull_request" },
        timestamp: Date.now() - 60000,
      }
    ];
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

  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return { success: true };
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

  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    return { success: true };
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