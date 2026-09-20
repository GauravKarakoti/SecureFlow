/**
 * SBOM Queue — Redis/BullMQ job queue for Software Bill of Materials (SBOM) scans.
 *
 * Offloads manifest dependency parsing and CVE vulnerability matching from
 * Next.js API routes and webhook handlers to background workers.
 *
 * Usage:
 *   import { enqueueSbomScan, getSbomJobStatus } from '@/lib/queue/sbomQueue';
 *   const { jobId, scanJobId } = await enqueueSbomScan({ fileName, content, userId });
 *   const status = await getSbomJobStatus(scanJobId);
 */

import { createHash } from "crypto";
import { Queue, Job } from "bullmq";
import { redis } from "./redis";
import prisma from "@/lib/prisma";
import type { ScanJobStatus } from "@prisma/client";
import type { SbomScanResult } from "@/types/sbom";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

export const SBOM_QUEUE_NAME = "sbom-scans";
export const SBOM_DLQ_NAME = "sbom-scans-dlq";

/** Maximum allowed manifest content size (1 MB default). */
export const MAX_SBOM_BYTES = 1024 * 1024;

/**
 * Audit action for an enqueued SBOM scan, as it is stored.
 *
 * `sanitizeAuditLogInput` upper-cases `action` on write, and Prisma compares
 * strings case-sensitively, so a lookup must use the stored spelling.
 */
export const SBOM_SCAN_ENQUEUED_ACTION = "SBOM SCAN ENQUEUED";

/**
 * The form of a dedupe key that is written to, and looked up in, audit metadata.
 *
 * Audit metadata is sanitized on write, and the secret redaction treats any run
 * of 40+ base64 characters as a token. The webhook's key contains the 40-character
 * head SHA, so the raw key was stored as `…:[REDACTED]:package.json` and never
 * equalled the key being looked up. A SHA-256 hex digest passes through the
 * sanitizer unchanged (pure hex is kept as a fingerprint) and still distinguishes
 * one commit from the next.
 */
export function sbomDedupeFingerprint(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex");
}

export interface SbomJobData {
  scanJobId: string;
  fileName: string;
  content: string;
  userId: string;
  repositoryId?: string;
  pullRequestId?: string;
}

export const sbomQueue = new Queue<SbomJobData>(SBOM_QUEUE_NAME, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
    removeOnComplete: { age: 86_400 }, // 24 hours
    removeOnFail: { age: 172_800 }, // 48 hours
  },
});

export const sbomDLQ = new Queue(SBOM_DLQ_NAME, {
  connection: redis as any,
});

/**
 * Make a job id BullMQ will accept.
 *
 * BullMQ rejects a custom job id containing `:` ("Custom Id cannot contain :")
 * unless it splits into exactly three parts, a form it keeps for legacy
 * repeatable jobs. `queue.add` throws before the job reaches Redis, so an id
 * like `sbom:<repo>-<pr>-<sha>-package_json` never enqueues at all.
 */
export function toSbomJobId(raw: string): string {
  return raw.replace(/:/g, "-");
}

export interface EnqueueSbomOptions {
  jobId?: string;
  dedupeKey?: string;
  deliveryId?: string;
}

/**
 * Enqueue an SBOM scan job.
 *
 * Checks for existing jobs via BullMQ or PostgreSQL deduplication keys before creating
 * a new ScanJob. Creates a persistent ScanJob record in PostgreSQL for lifecycle tracking,
 * records an AuditLog event for authorization and durability, and adds the job to BullMQ.
 */
export async function enqueueSbomScan(
  data: Omit<SbomJobData, "scanJobId">,
  options: EnqueueSbomOptions = {},
): Promise<{ jobId: string; scanJobId: string }> {
  // Validate content size
  const byteLength = Buffer.byteLength(data.content, "utf-8");
  if (byteLength > MAX_SBOM_BYTES) {
    throw new Error(`Manifest file exceeds maximum size limit of ${MAX_SBOM_BYTES} bytes`);
  }

  const targetJobId = options.jobId
    ? toSbomJobId(options.jobId)
    : options.dedupeKey
      ? toSbomJobId(`sbom-${options.dedupeKey}`)
      : null;

  // 1. If a deterministic jobId or dedupeKey is provided, check BullMQ for an existing job first
  if (targetJobId && process.env.NEXT_PUBLIC_MOCK_DB !== "true") {
    try {
      const existingJob = await sbomQueue.getJob(targetJobId);
      if (existingJob?.data?.scanJobId) {
        const existingScanJob = await prisma.scanJob.findUnique({
          where: { id: existingJob.data.scanJobId },
        });
        if (existingScanJob) {
          return { jobId: targetJobId, scanJobId: existingScanJob.id };
        }
      }
    } catch {
      // Redis unavailable or getJob failed; continue to PostgreSQL deduplication check
    }
  }

  // 2. Check PostgreSQL for an existing logical scan matching the dedupeKey
  if (options.dedupeKey) {
    try {
      const existingAudit = await prisma.auditLog.findFirst({
        where: {
          action: SBOM_SCAN_ENQUEUED_ACTION,
          metadata: {
            path: ["dedupeKey"],
            equals: sbomDedupeFingerprint(options.dedupeKey),
          },
        },
        select: { resource: true, metadata: true },
      });
      if (existingAudit) {
        const meta = existingAudit.metadata as Record<string, unknown> | null;
        const existingScanJobId = (meta?.scanJobId as string) || existingAudit.resource;
        if (existingScanJobId) {
          const existingScanJob = await prisma.scanJob.findUnique({
            where: { id: existingScanJobId },
          });
          if (existingScanJob) {
            return {
              jobId: targetJobId ?? `sbom-${existingScanJob.id}`,
              scanJobId: existingScanJob.id,
            };
          }
        }
      }
    } catch {
      // JSON query failed or unsupported; continue to create
    }
  }

  // 3. Create persistent ScanJob record in PostgreSQL
  const scanJob = await prisma.scanJob.create({
    data: {
      repositoryId: data.repositoryId || null,
      pullRequestId: data.pullRequestId || null,
      status: "PENDING",
      totalFiles: 1,
      scannedFiles: 0,
      vulnerabilitiesFound: 0,
    },
  });

  // 4. Create AuditLog entry linking user to this scanJob for authorization, auditability, and deduplication
  if (data.userId) {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId: data.userId,
        action: SBOM_SCAN_ENQUEUED_ACTION,
        resource: scanJob.id,
        metadata: {
          scanJobId: scanJob.id,
          fileName: data.fileName,
          repositoryId: data.repositoryId ?? null,
          pullRequestId: data.pullRequestId ?? null,
          dedupeKey: options.dedupeKey ? sbomDedupeFingerprint(options.dedupeKey) : null,
          deliveryId: options.deliveryId ?? null,
        },
      }),
    });
  }

  const finalJobId = targetJobId ?? `sbom-${scanJob.id}`;
  const jobPayload: SbomJobData = {
    ...data,
    scanJobId: scanJob.id,
  };

  // Mock DB support for CI / test environments without Redis
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    return { jobId: finalJobId, scanJobId: scanJob.id };
  }

  try {
    const added = await sbomQueue.add("process-sbom", jobPayload, {
      jobId: finalJobId,
      priority: 1,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
    });

    // Concurrency guard: if BullMQ returned an existing job with a different scanJobId, clean up our newly created orphaned scanJob
    if (
      added &&
      added.id === finalJobId &&
      added.data?.scanJobId &&
      added.data.scanJobId !== scanJob.id
    ) {
      await prisma.scanJob.delete({ where: { id: scanJob.id } }).catch(() => {});
      return { jobId: finalJobId, scanJobId: added.data.scanJobId };
    }
  } catch (err) {
    // If Redis enqueue fails, mark the ScanJob as FAILED so it does not stay PENDING forever
    await prisma.scanJob
      .update({
        where: { id: scanJob.id },
        data: {
          status: "FAILED",
          error: err instanceof Error ? err.message : "Failed to enqueue scan job",
        },
      })
      .catch(() => {});

    throw err;
  }

  return { jobId: finalJobId, scanJobId: scanJob.id };
}

export interface SbomJobStatusInfo {
  scanJobId: string;
  status: ScanJobStatus;
  totalFiles: number;
  scannedFiles: number;
  vulnerabilitiesFound: number;
  result: SbomScanResult | null;
  error: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Get the status of an SBOM scan job.
 *
 * Checks the database ScanJob row, cached result in Redis, and fallback AuditLog metadata.
 */
export async function getSbomJobStatus(scanJobId: string): Promise<SbomJobStatusInfo | null> {
  const job = await prisma.scanJob.findUnique({
    where: { id: scanJobId },
  });

  if (!job) return null;

  let result: SbomScanResult | null = null;

  // If completed, attempt to fetch the full SbomScanResult from Redis cache or BullMQ returnvalue
  if (job.status === "COMPLETED") {
    try {
      if (redis && typeof redis.get === "function") {
        const cached = await redis.get(`sbom:result:${scanJobId}`);
        if (cached) {
          result = JSON.parse(cached);
        }
      }
      if (!result) {
        const bullJob = await sbomQueue.getJob(`sbom-${scanJobId}`);
        if (bullJob?.returnvalue) {
          result = bullJob.returnvalue;
        }
      }
    } catch {
      // Non-fatal if Redis read fails; database status is authoritative
    }

    // Fallback to AuditLog metadata if Redis cache expired
    if (!result) {
      try {
        const audit = await prisma.auditLog.findFirst({
          where: {
            resource: scanJobId,
            action: { in: ["SBOM Scan Completed", "SBOM SCAN COMPLETED"] },
          },
          select: { metadata: true },
        });
        if (audit?.metadata && typeof audit.metadata === "object") {
          const meta = audit.metadata as Record<string, unknown>;
          if (meta.result) {
            result = meta.result as SbomScanResult;
          }
        }
      } catch {
        // Fallback read error ignored
      }
    }

    // Fallback to durable ScanResult if linked to a pullRequest
    if (!result && job.pullRequestId) {
      try {
        const scanResult = await prisma.scanResult.findFirst({
          where: { pullRequestId: job.pullRequestId },
          orderBy: { createdAt: "desc" },
          include: { findings: true },
        });
        if (scanResult) {
          result = {
            scanId: scanJobId,
            timestamp: scanResult.createdAt,
            totalDependencies: job.totalFiles,
            vulnerabilities: scanResult.findings.map((f: any) => ({
              dependency: {
                name: f.codeSnippet?.split("@")[0]?.replace("Dependency: ", "") || "unknown",
                version: f.codeSnippet?.split("@")[1]?.split("\n")[0] || "unknown",
              },
              cveId: f.explanation?.match(/CVE-[A-Za-z0-9-]+/)?.[0] || "CVE-UNKNOWN",
              severity: f.severity as any,
              description: f.explanation || "",
              patchedVersion:
                f.remediation?.replace(/Update .* to version | or higher\./g, "") || "",
            })),
            status: scanResult.policyDecision === "BLOCK" ? "VULNERABLE" : "CLEAN",
          };
        }
      } catch {
        // Fallback read error ignored
      }
    }
  }

  return {
    scanJobId: job.id,
    status: job.status,
    totalFiles: job.totalFiles,
    scannedFiles: job.scannedFiles,
    vulnerabilitiesFound: job.vulnerabilitiesFound,
    result,
    error: job.error,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * Queue metrics for monitoring.
 */
export async function getSbomQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    sbomQueue.getWaitingCount(),
    sbomQueue.getActiveCount(),
    sbomQueue.getCompletedCount(),
    sbomQueue.getFailedCount(),
    sbomQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}
