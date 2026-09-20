/**
 * SBOM Worker — Background worker for processing queued SBOM scans.
 *
 * Consumes jobs from the 'sbom-scans' BullMQ queue, performs manifest dependency
 * parsing and CVE matching, updates the ScanJob lifecycle in PostgreSQL,
 * durably persists results to AuditLog and Redis cache, and routes permanent
 * failures to the Dead Letter Queue (DLQ).
 */

import { Worker, Job, UnrecoverableError } from "bullmq";
import { redis } from "./redis";
import prisma from "@/lib/prisma";
import { isSupportedManifest, parseManifestFile } from "@/lib/sbom/dependency-parser";
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
 * Recover the persisted result of an already-completed ScanJob without reprocessing.
 */
/**
 * The snippet this worker stores for a dependency finding (see step 6 below):
 * `Dependency: <name>@<version>\nPatched: <version | Unknown>`. The name match is
 * greedy so a scoped npm package (`@scope/pkg@1.0.0`) splits at its last `@`.
 */
const DEPENDENCY_SNIPPET = /^Dependency: (.+)@([^@\n]+)\nPatched: (.*)$/;

/** Rebuild one match from a stored dependency finding. */
function recoveredMatch(
  finding: { codeSnippet?: string | null; explanation?: string | null; severity: string },
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
  // 1. Try Redis cache (ephemeral acceleration)
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

  // 2. Recover from PostgreSQL AuditLog
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
    const ownFindings = { fileLocation: fileName, type: "VULNERABILITY" as const };
    try {
      const scanResult = await prisma.scanResult.findFirst({
        where: { pullRequestId, findings: { some: ownFindings } },
        orderBy: { createdAt: "desc" },
        include: { findings: { where: ownFindings } },
      });
      if (scanResult && scanResult.findings.length > 0) {
        const vulnerabilities = scanResult.findings.map((f: any) => recoveredMatch(f, fileName));
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

  // 4. If result genuinely cannot be recovered, raise terminal error rather than silently reprocessing
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

  // 1. Query ScanJob first
  const existingJob = await prisma.scanJob.findUnique({
    where: { id: scanJobId },
  });

  if (!existingJob) {
    throw new UnrecoverableError(`ScanJob ${scanJobId} not found`);
  }

  const effectivePrId = pullRequestId || existingJob.pullRequestId;
  const effectiveRepoId = repositoryId || existingJob.repositoryId;

  // 2. Idempotency check: if this scan is already COMPLETED, recover result without reprocessing
  if (existingJob.status === "COMPLETED") {
    log.info("SBOM scan job already completed, recovering durable result", { scanJobId });
    return await recoverCompletedResult(
      scanJobId,
      effectivePrId,
      fileName,
      existingJob.vulnerabilitiesFound,
    );
  }

  // 3. Concurrency-safe transition to PROCESSING
  const updateResult = await prisma.scanJob.updateMany({
    where: {
      id: scanJobId,
      status: "PENDING",
    },
    data: {
      status: "PROCESSING",
      startedAt: new Date(),
    },
  });

  if (updateResult.count === 0) {
    // Another worker already advanced this job
    const current = await prisma.scanJob.findUnique({ where: { id: scanJobId } });
    if (current?.status === "COMPLETED") {
      log.info("SBOM scan job completed concurrently, recovering durable result", { scanJobId });
      return await recoverCompletedResult(
        scanJobId,
        effectivePrId,
        fileName,
        current.vulnerabilitiesFound,
      );
    }
    if (current?.status === "PROCESSING") {
      log.info("SBOM scan job already PROCESSING by another worker", { scanJobId });
      return {
        scanId: scanJobId,
        timestamp: new Date(),
        totalDependencies: 0,
        vulnerabilities: [],
        status: "CLEAN",
      };
    }
  }

  try {
    // 4. Early validation of the manifest — avoid retrying inherently unreadable inputs, and
    //    never report CLEAN for a file whose dependencies could not be read at all.
    const failUnreadable = async (errorMsg: string): Promise<never> => {
      await prisma.scanJob
        .update({
          where: { id: scanJobId },
          data: {
            status: "FAILED",
            error: errorMsg,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
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
    }

    // 5. Perform dependency parsing and vulnerability matching
    const dependencies = parseManifestFile(content, fileName);
    const vulnerabilities = await matchVulnerabilities(dependencies);

    const result: SbomScanResult = {
      scanId: scanJobId,
      timestamp: new Date(),
      totalDependencies: dependencies.length,
      vulnerabilities,
      status: vulnerabilities.length > 0 ? "VULNERABLE" : "CLEAN",
    };

    const riskScore = totalRiskScore(vulnerabilities.map((v) => ({ severity: v.severity })));
    const policyDecision = vulnerabilities.length > 0 ? "BLOCK" : "PASS";

    // 6. Durably persist findings and completed status inside a Prisma transaction
    await prisma.$transaction(async (tx: any) => {
      // Persist standard ScanResult and Finding records if pullRequestId is available
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

      // Mark ScanJob as COMPLETED atomically with findings persistence
      await tx.scanJob.update({
        where: { id: scanJobId },
        data: {
          status: "COMPLETED",
          scannedFiles: 1,
          vulnerabilitiesFound: vulnerabilities.length,
          riskScore: Math.round(riskScore),
          policyDecision: normalizePolicyDecisionEnum(policyDecision),
          completedAt: new Date(),
        },
      });

      // Record completed event in PostgreSQL AuditLog
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

    // 7. Cache in Redis for fast status polling retrieval (24 hour TTL)
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

    // If unrecoverable, mark FAILED immediately
    if (isUnrecoverable) {
      await prisma.scanJob
        .update({
          where: { id: scanJobId },
          data: {
            status: "FAILED",
            error: errorMessage,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      throw err;
    }

    // For transient errors, check if this was the last attempt
    const maxAttempts = job.opts.attempts ?? 3;
    if (job.attemptsMade >= maxAttempts - 1) {
      await prisma.scanJob
        .update({
          where: { id: scanJobId },
          data: {
            status: "FAILED",
            error: errorMessage,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
    } else {
      // Hand the ScanJob back for BullMQ's retry. Left PROCESSING, the retry's
      // PENDING -> PROCESSING claim above matches no row, the job is taken for
      // one "already PROCESSING by another worker", and it completes with an
      // empty CLEAN result while the ScanJob stays PROCESSING for good.
      await prisma.scanJob
        .updateMany({
          where: { id: scanJobId, status: "PROCESSING" },
          data: { status: "PENDING", startedAt: null },
        })
        .catch(() => {});
    }

    throw err;
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
