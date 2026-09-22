/**
 * SBOM Worker — Background worker for processing queued SBOM scans.
 *
 * Consumes jobs from the 'sbom-scans' BullMQ queue, performs manifest dependency
 * parsing and CVE matching, updates the ScanJob lifecycle in PostgreSQL,
 * durably persists results to AuditLog and Redis cache, and routes permanent
 * failures to the Dead Letter Queue (DLQ).
 *
 * Crash recovery:
 * - A worker claims a ScanJob with a unique processing token and expiring lease.
 * - Active leases prevent duplicate workers from processing the same scan.
 * - Expired leases can be reclaimed by a redelivered BullMQ job.
 * - A heartbeat renews the lease while processing is underway.
 * - State changes are guarded by the processing token to prevent stale workers
 *   from modifying a job that has been reclaimed by another worker.
 */

import { randomUUID } from "node:crypto";
import { Worker, Job, UnrecoverableError } from "bullmq";
import { redis } from "./redis";
import prisma from "@/lib/prisma";
import {
  isSupportedManifest,
  isSbomManifest,
  parseManifestFile,
} from "@/lib/sbom/dependency-parser";
import { detectAndParseSbom } from "@/lib/sbom/sbom-format-detector";
import { matchVulnerabilities } from "@/lib/sbom/vulnerability-matcher";
import { sbomDLQ, SbomJobData, SBOM_QUEUE_NAME } from "./sbomQueue";
import type { SbomScanResult, VulnerabilityMatch } from "@/types/sbom";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { createLogger } from "@/lib/logger";
import { computeFingerprint } from "@/lib/armor/fingerprint";
import { toStoredSeverity, totalRiskScore } from "@/lib/severity";
import { normalizePolicyDecisionEnum } from "@/lib/finding-taxonomy";

const log = createLogger({ context: { component: "sbom-worker" } });

export const DEFAULT_SBOM_CONCURRENCY = 5;

/**
 * Lease duration and heartbeat interval.
 *
 * The heartbeat interval is deliberately shorter than the lease duration so
 * that a healthy worker can renew its lease before it expires.
 */
const SCAN_LEASE_DURATION_MS = 60_000;
const SCAN_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Recover the persisted result of an already-completed ScanJob without reprocessing.
 */

/**
 * The snippet this worker stores for a dependency finding:
 * `Dependency: <name>@<version>\nPatched: <version | Unknown>`.
 * The name match is greedy so a scoped npm package (`@scope/pkg@1.0.0`)
 * splits at its last `@`.
 */
const DEPENDENCY_SNIPPET = /^Dependency: (.+)@([^@\n]+)\nPatched: (.*)$/;

/** Rebuild one match from a stored dependency finding. */
function recoveredMatch(
  finding: {
    codeSnippet?: string | null;
    explanation?: string | null;
    severity: string;
  },
  fileName: string,
): VulnerabilityMatch {
  const [, name = "unknown", version = "unknown", patched] =
    DEPENDENCY_SNIPPET.exec(finding.codeSnippet ?? "") ?? [];

  return {
    dependency: {
      name,
      version,
      manifestFile: fileName,
      ecosystem: fileName.endsWith("package.json") ? "npm" : "pypi",
    },
    cveId: finding.explanation?.match(/CVE-[A-Za-z0-9-]+/)?.[0] || "CVE-UNKNOWN",
    severity: finding.severity as VulnerabilityMatch["severity"],
    description: finding.explanation || "",
    patchedVersion: patched && patched !== "Unknown" ? patched : null,
  };
}

async function recoverCompletedResult(
  scanJobId: string,
  pullRequestId: string | null | undefined,
  fileName: string,
  vulnerabilitiesFound?: number | null,
): Promise<SbomScanResult> {
  // 1. Try Redis cache (ephemeral acceleration).
  if (redis && typeof redis.get === "function") {
    try {
      const cached = await redis.get(`sbom:result:${scanJobId}`);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      log.warn("Redis unavailable during completed result recovery", {
        scanJobId,
        error: (err as Error).message,
      });
    }
  }

  // 2. Recover from PostgreSQL AuditLog.
  try {
    const completedAudit = await prisma.auditLog.findFirst({
      where: {
        resource: scanJobId,
        action: { in: ["SBOM Scan Completed", "SBOM SCAN COMPLETED"] },
      },
      select: { metadata: true },
    });

    if (completedAudit?.metadata && typeof completedAudit.metadata === "object") {
      const meta = completedAudit.metadata as Record<string, unknown>;
      if (meta.result) {
        return meta.result as SbomScanResult;
      }
    }
  } catch (err) {
    log.warn("AuditLog lookup failed during completed result recovery", {
      scanJobId,
      error: (err as Error).message,
    });
  }

  // 3. Recover from durable ScanResult and Findings if pullRequest is associated.
  //
  // Only this manifest's dependency findings. The latest ScanResult on the pull
  // request is not necessarily this job's: the code scan writes one too (with
  // SECRET / MISCONFIG findings), and a pull request that changes two manifests
  // gets one SBOM ScanResult per manifest. Taking the latest one whole reported
  // another scan's findings as this job's result.
  if (pullRequestId) {
    const ownFindings = {
      fileLocation: fileName,
      type: "VULNERABILITY" as const,
    };

    try {
      const scanResult = await prisma.scanResult.findFirst({
        where: { pullRequestId, findings: { some: ownFindings } },
        orderBy: { createdAt: "desc" },
        include: { findings: { where: ownFindings } },
      });

      if (scanResult && scanResult.findings.length > 0) {
        const vulnerabilities = scanResult.findings.map((finding: any) =>
          recoveredMatch(finding, fileName),
        );

        return {
          scanId: scanJobId,
          timestamp: scanResult.createdAt,
          totalDependencies: 0,
          vulnerabilities,
          status: "VULNERABLE",
        };
      }
    } catch (err) {
      log.warn("ScanResult lookup failed during completed result recovery", {
        scanJobId,
        error: (err as Error).message,
      });
    }
  }

  // A completed scan that found nothing stores no findings to recover, but its
  // ScanJob row says so, and that is the whole result.
  if (vulnerabilitiesFound === 0) {
    return {
      scanId: scanJobId,
      timestamp: new Date(),
      totalDependencies: 0,
      vulnerabilities: [],
      status: "CLEAN",
    };
  }

  // 4. If the result genuinely cannot be recovered, raise a terminal error
  // rather than silently reprocessing.
  throw new UnrecoverableError(
    `Persisted result for completed ScanJob ${scanJobId} cannot be recovered`,
  );
}

/**
 * Process a single SBOM scan job.
 *
 * Exported so unit tests can invoke it directly without reaching into BullMQ internals.
 */
export async function processSbomJob(job: Job<SbomJobData>): Promise<SbomScanResult> {
  const { scanJobId, fileName, content, userId, repositoryId, pullRequestId } = job.data;

  // 1. Query ScanJob first.
  const existingJob = await prisma.scanJob.findUnique({
    where: { id: scanJobId },
  });

  if (!existingJob) {
    throw new UnrecoverableError(`ScanJob ${scanJobId} not found`);
  }

  const effectivePrId = pullRequestId || existingJob.pullRequestId;
  const effectiveRepoId = repositoryId || existingJob.repositoryId;

  // 2. Idempotency check: if this scan is already COMPLETED, recover its result.
  if (existingJob.status === "COMPLETED") {
    log.info("SBOM scan job already completed, recovering durable result", {
      scanJobId,
    });

    return await recoverCompletedResult(
      scanJobId,
      effectivePrId,
      fileName,
      existingJob.vulnerabilitiesFound,
    );
  }

  // 3. Claim the job with a unique token.
  //
  // A PENDING job can be claimed immediately. A PROCESSING job can only be
  // reclaimed if its lease is absent or has expired. The conditional update
  // ensures that two workers cannot successfully claim the same lease.
  const processingToken = randomUUID();
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + SCAN_LEASE_DURATION_MS);

  const claimResult = await prisma.scanJob.updateMany({
    where: {
      id: scanJobId,
      OR: [
        { status: "PENDING" },
        {
          status: "PROCESSING",
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
      ],
    },
    data: {
      status: "PROCESSING",
      startedAt: now,
      processingToken,
      leaseExpiresAt,
    },
  });

  if (claimResult.count === 0) {
    // Another worker may have completed the scan while this worker was trying
    // to claim it, so check the latest durable state before deciding what to do.
    const current = await prisma.scanJob.findUnique({
      where: { id: scanJobId },
    });

    if (current?.status === "COMPLETED") {
      log.info("SBOM scan job completed concurrently, recovering durable result", {
        scanJobId,
      });

      return await recoverCompletedResult(
        scanJobId,
        effectivePrId,
        fileName,
        current.vulnerabilitiesFound,
      );
    }

    if (current?.status === "PROCESSING") {
      const activeLease =
        current.leaseExpiresAt instanceof Date && current.leaseExpiresAt.getTime() > Date.now();

      if (activeLease) {
        log.info("SBOM scan job has an active lease owned by another worker", {
          scanJobId,
        });
      } else {
        log.warn("SBOM scan job could not be reclaimed after lease expiry", {
          scanJobId,
        });
      }

      // Throwing allows BullMQ's retry/backoff mechanism to redeliver the job.
      // Never return a synthetic CLEAN result for work that has not completed.
      throw new Error(`ScanJob ${scanJobId} is already being processed or could not be claimed`);
    }

    throw new Error(
      `Unable to claim ScanJob ${scanJobId}; current status is ${current?.status ?? "unknown"}`,
    );
  }

  let heartbeatInProgress = false;
  let ownershipLost = false;

  /**
   * Verify ownership before performing durable operations.
   */
  const assertOwnership = (): void => {
    if (ownershipLost) {
      throw new Error(`Worker lost its lease for ScanJob ${scanJobId}`);
    }
  };

  /**
   * Renew the lease while this worker is processing the scan.
   *
   * The update is guarded by the processing token. If another worker has
   * reclaimed the job, this worker cannot renew the other worker's lease.
   */
  const renewLease = async (): Promise<void> => {
    if (heartbeatInProgress || ownershipLost) {
      return;
    }

    heartbeatInProgress = true;

    try {
      const heartbeatNow = new Date();

      const heartbeatResult = await prisma.scanJob.updateMany({
        where: {
          id: scanJobId,
          status: "PROCESSING",
          processingToken,
          leaseExpiresAt: { gt: heartbeatNow },
        },
        data: {
          leaseExpiresAt: new Date(heartbeatNow.getTime() + SCAN_LEASE_DURATION_MS),
        },
      });

      if (heartbeatResult.count !== 1) {
        ownershipLost = true;

        log.warn("SBOM worker lost its processing lease", {
          scanJobId,
        });
      }
    } catch (err) {
      // A failed heartbeat means ownership cannot be safely assumed. Stop this
      // worker from persisting a result; BullMQ can retry the job.
      ownershipLost = true;

      log.error("Failed to renew SBOM processing lease", {
        scanJobId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      heartbeatInProgress = false;
    }
  };

  const heartbeatTimer = setInterval(() => {
    void renewLease();
  }, SCAN_HEARTBEAT_INTERVAL_MS);

  // Do not keep the Node.js process alive solely for the heartbeat timer.
  if (typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    heartbeatTimer.unref();
  }

  try {
    // 4. Early validation of the manifest — avoid retrying inherently unreadable
    // inputs, and never report CLEAN for a file whose dependencies could not be read.
    const failUnreadable = async (errorMsg: string): Promise<never> => {
      assertOwnership();

      await prisma.scanJob.updateMany({
        where: {
          id: scanJobId,
          status: "PROCESSING",
          processingToken,
        },
        data: {
          status: "FAILED",
          error: errorMsg,
          completedAt: new Date(),
          startedAt: null,
          processingToken: null,
          leaseExpiresAt: null,
        },
      });

      throw new UnrecoverableError(errorMsg);
    };

    if (!isSupportedManifest(fileName)) {
      await failUnreadable(`Unsupported manifest file ${fileName}`);
    }

    if (fileName.endsWith("package.json")) {
      let manifest: unknown;

      try {
        manifest = JSON.parse(content);
      } catch {
        await failUnreadable(`Invalid JSON syntax in ${fileName}`);
      }

      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        await failUnreadable(`${fileName} must contain a JSON object`);
      }
    } else if (isSbomManifest(fileName)) {
      let sbomDoc: unknown;

      try {
        sbomDoc = JSON.parse(content);
      } catch {
        await failUnreadable(`Invalid JSON syntax in ${fileName}`);
      }

      const detection = detectAndParseSbom(sbomDoc, fileName);

      if (!detection) {
        await failUnreadable(`${fileName} is not a recognized CycloneDX or SPDX document`);
      }
    }

    assertOwnership();

    // 5. Perform dependency parsing and vulnerability matching.
    const dependencies = parseManifestFile(content, fileName);
    const vulnerabilities = await matchVulnerabilities(dependencies);

    // If a heartbeat failed or the lease was reclaimed during parsing, do not
    // allow this worker to persist a result.
    assertOwnership();

    const result: SbomScanResult = {
      scanId: scanJobId,
      timestamp: new Date(),
      totalDependencies: dependencies.length,
      vulnerabilities,
      status: vulnerabilities.length > 0 ? "VULNERABLE" : "CLEAN",
    };

    const riskScore = totalRiskScore(
      vulnerabilities.map((vulnerability) => ({
        severity: vulnerability.severity,
      })),
    );

    const policyDecision = vulnerabilities.length > 0 ? "BLOCK" : "PASS";

    // Make a final lease renewal before entering the persistence transaction.
    await renewLease();
    assertOwnership();

    // 6. Durably persist findings and completed status inside a Prisma transaction.
    await prisma.$transaction(async (tx: any) => {
      assertOwnership();

      // Persist standard ScanResult and Finding records if pullRequestId is available.
      if (effectivePrId) {
        const findingsData = vulnerabilities.map((vuln) => {
          const depSnippet = `Dependency: ${vuln.dependency.name}@${vuln.dependency.version}\nPatched: ${vuln.patchedVersion || "Unknown"}`;

          const fingerprint = computeFingerprint(
            effectiveRepoId || "unknown",
            fileName,
            "Vulnerability",
            `${vuln.dependency.name}@${vuln.dependency.version}`,
          );

          return {
            type: "VULNERABILITY" as const,
            severity: toStoredSeverity(vuln.severity),
            fileLocation: fileName,
            lineStart: null,
            lineEnd: null,
            codeSnippet: depSnippet,
            explanation:
              vuln.description ||
              `Detected known vulnerability ${vuln.cveId} in ${vuln.dependency.name}.`,
            remediation: vuln.patchedVersion
              ? `Update ${vuln.dependency.name} to version ${vuln.patchedVersion} or higher.`
              : null,
            promptInjectionSuspected: false,
            fingerprint,
          };
        });

        await tx.scanResult.create({
          data: {
            pullRequestId: effectivePrId,
            riskScore: Math.round(riskScore),
            policyDecision: normalizePolicyDecisionEnum(policyDecision),
            findings: {
              create: findingsData,
            },
          },
        });
      }

      // Mark the ScanJob as COMPLETED only if this worker still owns it.
      // Throwing inside the transaction rolls back any findings written above.
      const completionResult = await tx.scanJob.updateMany({
        where: {
          id: scanJobId,
          status: "PROCESSING",
          processingToken,
        },
        data: {
          status: "COMPLETED",
          scannedFiles: 1,
          vulnerabilitiesFound: vulnerabilities.length,
          riskScore: Math.round(riskScore),
          policyDecision: normalizePolicyDecisionEnum(policyDecision),
          completedAt: new Date(),
          startedAt: null,
          processingToken: null,
          leaseExpiresAt: null,
        },
      });

      if (completionResult.count !== 1) {
        throw new Error(`Worker no longer owns ScanJob ${scanJobId}; completion was aborted`);
      }

      // Record completed event in PostgreSQL AuditLog.
      if (userId) {
        await tx.auditLog.create({
          data: sanitizeAuditLogInput({
            userId,
            action: "SBOM Scan Completed",
            resource: scanJobId,
            decision: result.status,
            metadata: {
              scanJobId,
              fileName,
              repositoryId: effectiveRepoId ?? null,
              pullRequestId: effectivePrId ?? null,
              totalDependencies: dependencies.length,
              vulnerabilitiesCount: vulnerabilities.length,
              result,
            },
          }),
        });
      }
    });

    // 7. Cache in Redis for fast status polling retrieval (24 hour TTL).
    if (redis && typeof redis.set === "function") {
      try {
        await redis.set(`sbom:result:${scanJobId}`, JSON.stringify(result), "EX", 86_400);
      } catch (cacheErr) {
        log.warn("Failed to cache SBOM result in Redis", {
          scanJobId,
          error: (cacheErr as Error).message,
        });
      }
    }

    log.info("SBOM scan job completed successfully", {
      scanJobId,
      totalDependencies: dependencies.length,
      vulnerabilitiesCount: vulnerabilities.length,
    });

    return result;
  } catch (err) {
    const isUnrecoverable = err instanceof UnrecoverableError;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // State changes in this handler are guarded by the processing token. A stale
    // worker must not reset or fail a job that has been reclaimed by another worker.
    if (isUnrecoverable) {
      await prisma.scanJob
        .updateMany({
          where: {
            id: scanJobId,
            status: "PROCESSING",
            processingToken,
          },
          data: {
            status: "FAILED",
            error: errorMessage,
            completedAt: new Date(),
            startedAt: null,
            processingToken: null,
            leaseExpiresAt: null,
          },
        })
        .catch(() => {});

      throw err;
    }

    // For transient errors, check whether this was the last attempt.
    const maxAttempts = job.opts.attempts ?? 3;

    if (job.attemptsMade >= maxAttempts - 1) {
      await prisma.scanJob
        .updateMany({
          where: {
            id: scanJobId,
            status: "PROCESSING",
            processingToken,
          },
          data: {
            status: "FAILED",
            error: errorMessage,
            completedAt: new Date(),
            startedAt: null,
            processingToken: null,
            leaseExpiresAt: null,
          },
        })
        .catch(() => {});
    } else {
      // Return the job to PENDING for BullMQ's retry, but only if this worker
      // still owns the processing token.
      await prisma.scanJob
        .updateMany({
          where: {
            id: scanJobId,
            status: "PROCESSING",
            processingToken,
          },
          data: {
            status: "PENDING",
            startedAt: null,
            processingToken: null,
            leaseExpiresAt: null,
          },
        })
        .catch(() => {});
    }

    throw err;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

const concurrency = parseInt(
  process.env.SBOM_WORKER_CONCURRENCY ?? String(DEFAULT_SBOM_CONCURRENCY),
  10,
);

export const sbomWorker = new Worker<SbomJobData>(SBOM_QUEUE_NAME, processSbomJob, {
  connection: redis as any,
  concurrency:
    Number.isFinite(concurrency) && concurrency > 0 ? concurrency : DEFAULT_SBOM_CONCURRENCY,
});

sbomWorker.on("completed", (job: Job) => {
  log.info("SBOM job completed", { jobId: job.id });
});

sbomWorker.on("failed", async (job: Job | undefined, err: Error) => {
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 3;
  const isUnrecoverable = err instanceof UnrecoverableError || err.name === "UnrecoverableError";
  const exhausted = job.attemptsMade >= maxAttempts;

  if (!exhausted && !isUnrecoverable) {
    log.warn("SBOM job failed, retrying with backoff", {
      jobId: job.id,
      attempt: job.attemptsMade,
      maxAttempts,
      reason: err.message,
    });

    return;
  }

  log.error("SBOM job permanently failed, routing to DLQ", {
    jobId: job.id,
    attempts: job.attemptsMade,
    reason: err.message,
  });

  try {
    await sbomDLQ.add("failed-sbom-scan", {
      originalJobId: job.id,
      data: job.data,
      failedReason: err.message,
      failedAt: new Date().toISOString(),
      attemptsMade: job.attemptsMade,
      unrecoverable: isUnrecoverable,
    });
  } catch (dlqErr) {
    log.error("Failed to route SBOM job to DLQ", {
      jobId: job.id,
      error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
    });
  }
});
