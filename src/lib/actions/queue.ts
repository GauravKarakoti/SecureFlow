"use server";

import { webhookQueue } from '@/lib/queue/webhookQueue';
import { auth } from '@/auth';

export async function getQueueMetrics() {
  const session = await auth();
  const roles = (session?.user as any)?.roles || [];

  if (!roles.includes("ADMIN")) {
    throw new Error("Unauthorized");
  }

  const counts = await webhookQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  return counts;
}
