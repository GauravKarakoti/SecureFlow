/**
 * Scan Queue — Redis/BullMQ job queue for repository vulnerability scans.
 *
 * Offloads scan requests from Next.js API routes to background workers,
 * preventing event loop blocking and HTTP gateway timeouts on large repos.
 *
 * Usage:
 *   import { enqueueScan, getScanJobStatus } from '@/lib/queue/scanQueue';
 *   const job = await enqueueScan({ repositoryId, pullRequestData, fileChanges });
 *   const status = await getScanJobStatus(job.id);
 */

import { Queue, Job } from 'bullmq';
import { redis } from './redis';
import prisma from '@/lib/prisma';
export type ScanJobStatus = 'PENDING' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

// --- Job data types ---

export interface ScanJobData {
  /** The database ScanJob ID (used for progress tracking). */
  scanJobId: string;
  /** Repository database ID. */
  repositoryId: string;
  /** GitHub installation ID for API access. */
  installationId: number | string;
  /** Repository full name (owner/repo). */
  repositoryFullName: string;
  /** PR number. */
  prNumber: number;
  /** Head SHA for check runs. */
  headSha: string;
  /** File changes to scan (filename + patch). */
  fileChanges: Array<{ filename: string; patch: string }>;
  /** Active policy descriptions. */
  activePolicies: Array<{ description: string; [key: string]: unknown }>;
  /** Custom ignore patterns from .secureflowignore. */
  customIgnores: string[];
  /** Custom placeholder strings for false positive filtering. */
  customPlaceholders: string[];
  /** User ID for audit logging. */
  userId?: string;
}

// --- Queue setup ---

const SCAN_QUEUE_NAME = 'vulnerability-scans';
const SCAN_DLQ_NAME = 'vulnerability-scans-dlq';

export const scanQueue = new Queue<ScanJobData>(SCAN_QUEUE_NAME, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 10_000,
    },
    removeOnComplete: { age: 86_400 }, // 24 hours
    removeOnFail: { age: 172_800 },   // 48 hours
  },
});

export const scanDLQ = new Queue(SCAN_DLQ_NAME, {
  connection: redis as any,
});

// --- Enqueue ---

export interface EnqueueScanOptions {
  jobId?: string;
}

/**
 * Enqueue a vulnerability scan job.
 *
 * Creates a ScanJob record in the database for progress tracking,
 * then adds the job to the Redis queue.
 */
export async function enqueueScan(
  data: ScanJobData,
  options: EnqueueScanOptions = {}
): Promise<{ jobId: string; scanJobId: string }> {
  // Create the persistent scan job record
  const scanJob = await prisma.scanJob.create({
    data: {
      repositoryId: data.repositoryId || null,
      status: 'PENDING',
      totalFiles: data.fileChanges.length,
      scannedFiles: 0,
      vulnerabilitiesFound: 0,
    },
  });

  const jobId = options.jobId ?? `scan-${scanJob.id}`;

  await scanQueue.add('scan-repository', data, {
    jobId,
    priority: 1, // Normal priority
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
  });

  console.log(`[ScanQueue] Enqueued scan job ${jobId} for ${data.repositoryFullName}#${data.prNumber}`);

  return { jobId, scanJobId: scanJob.id };
}

// --- Status tracking ---

export interface ScanJobStatusInfo {
  scanJobId: string;
  status: ScanJobStatus;
  totalFiles: number;
  scannedFiles: number;
  vulnerabilitiesFound: number;
  riskScore: number | null;
  policyDecision: string | null;
  error: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Progress percentage (0-100). */
  progress: number;
}

/**
 * Get the status of a scan job from the database.
 */
export async function getScanJobStatus(
  scanJobId: string
): Promise<ScanJobStatusInfo | null> {
  const job = await prisma.scanJob.findUnique({
    where: { id: scanJobId },
  });

  if (!job) return null;

  const progress = job.totalFiles > 0
    ? Math.round((job.scannedFiles / job.totalFiles) * 100)
    : 0;

  return {
    scanJobId: job.id,
    status: job.status,
    totalFiles: job.totalFiles,
    scannedFiles: job.scannedFiles,
    vulnerabilitiesFound: job.vulnerabilitiesFound,
    riskScore: job.riskScore,
    policyDecision: job.policyDecision,
    error: job.error,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    progress,
  };
}

/**
 * Update scan job progress in the database.
 */
export async function updateScanJobProgress(
  scanJobId: string,
  updates: {
    scannedFiles?: number;
    vulnerabilitiesFound?: number;
    status?: ScanJobStatus;
    error?: string;
    riskScore?: number;
    policyDecision?: string;
    startedAt?: Date;
    completedAt?: Date;
  }
): Promise<void> {
  await prisma.scanJob.update({
    where: { id: scanJobId },
    data: updates,
  });
}

/**
 * Get the BullMQ job by its ID.
 */
export async function getBullMQJob(jobId: string): Promise<Job<ScanJobData> | null> {
  return (await scanQueue.getJob(jobId)) ?? null;
}

/**
 * Get queue metrics for monitoring.
 */
export async function getScanQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    scanQueue.getWaitingCount(),
    scanQueue.getActiveCount(),
    scanQueue.getCompletedCount(),
    scanQueue.getFailedCount(),
    scanQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}
