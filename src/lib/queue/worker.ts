import { Worker, Job, DelayedError } from "bullmq";
import { withSpan, extractTraceContext, type Context } from "@/lib/tracing";
import { postScanCheckRun, postScanErrorCheckRun } from "../scanner/check-run";
import { z } from "zod";
import { redis } from "./redis";
import { webhookDLQ, WebhookJobData } from "./webhookQueue";
import { dlqRetryStateFor } from "./dlq-auto-retry";
import { acquireLock, releaseLock, startLockHeartbeat } from "./lock";
import { scanner } from "@/lib/armor/scanner";
import { processScanJob } from "@/lib/scanner/scanEngine";
import type { ScanJobData } from "@/lib/queue/scanQueue";
import { maskFindingText } from "@/lib/armor/secret-masking";
import { iq } from "@/lib/armor/iq";
import {
  loadTrustedGateConfig,
  formatGateSummaryLine,
  type GateConfig,
} from "@/lib/scanner/gate-config";
import { autoResolveFixedFindings } from "@/lib/findings/auto-resolve";
import { formatAppliedScopesSection } from "@/lib/scanner/policy-scopes";
import type { IgnoreConfigClient } from "@/lib/scanner/ignore-config";
import { computeFingerprint } from "@/lib/armor/fingerprint";
import { commentableLineNumbers, parseUnifiedPatch } from "@/lib/armor/diff";
import { developerReceivesAISecurityExplanations } from "@/ai/flows/developer-receives-ai-security-explanations";
import { App } from "octokit";
import { fetchPullRequestFiles, formatCoverageNotice } from "@/lib/github/pull-request-files";
import { renderScanReportSummary, SECUREFLOW_COMMENT_MARKER } from "@/lib/github/scan-report";
import { upsertSecureFlowComment } from "@/lib/github/sticky-comment";
import {
  buildSarifDocument,
  pullRequestRef,
  uploadSarifAnalysis,
  type CodeScanningClient,
  type CodeScanningFinding,
} from "@/lib/github/code-scanning";
import {
  buildPullRequestFacts,
  classifyPullRequestAction,
  pullRequestUpdateData,
} from "@/lib/github/pull-request-facts";
import prisma from "@/lib/prisma";
import { getGitHubAppCredentials } from "@/lib/github/app-auth";
import { isSecureFlowCheckRun, isSecureFlowCheckSuite } from "@/lib/github/webhook-verification";
import { handlePullRequestSynchronize } from "@/lib/sbom/pull-request-manifests";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { severityBadge, toStoredSeverity, totalRiskScore } from "@/lib/severity";
import {
  normalizeFindingTypeEnum,
  normalizePolicyDecisionEnum,
  normalizePrStatusEnum,
} from "@/lib/finding-taxonomy";
import { logger, sanitizeLogValue } from "@/lib/logger";
import { getActivePoliciesForUser } from "@/lib/policies/policy-cache";
import { notifyHighSeverityFindings } from "@/lib/integrations/slack";
import { notifyBlockedScan } from "@/lib/integrations/notification-dispatcher";
import { publishVoiceAlert } from "@/lib/voice-alert-events";
import {
  dispatchOutboundWebhooksForUser,
  buildScanCompletedPayload,
  buildScanBlockedPayload,
  buildFindingCreatedPayload,
} from "@/lib/webhooks/outbound-dispatcher";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { activeSuppressionWhere } from "../triage/expiry";
import {
  extractPrNumberFromMergeGroup,
  fetchMergeGroupFiles,
  isMergeGroupDiffUnchanged,
} from "@/lib/github/merge-group";

// Sanitize user-controlled strings before logging to prevent log injection
// (CWE-117). The implementation moved to src/lib/logger.ts so every module gets
// it rather than only this one (#563); the local alias keeps the ~40 call sites
// below unchanged.
const sanitize = sanitizeLogValue;

// 1. Strict input validation schemas
const repoSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    full_name: z.string(),
    name: z.string().optional(),
    owner: z
      .object({
        login: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const payloadSchema = z
  .object({
    action: z.string().optional(),
    pull_request: z
      .object({
        id: z.union([z.number(), z.string()]),
        number: z.number(),
        title: z.string().optional(),
        state: z.string().optional(),
        merged: z.boolean().optional(),
        merged_at: z.string().nullable().optional(),
        head: z
          .object({
            sha: z.string(),
          })
          .passthrough()
          .optional(),
        user: z
          .object({
            login: z.string(),
            avatar_url: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    merge_group: z
      .object({
        head_sha: z.string(),
        head_ref: z.string().optional(),
        base_sha: z.string().optional(),
        base_ref: z.string().optional(),
        head_commit: z
          .object({
            id: z.string().optional(),
            message: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    repository: repoSchema.optional(),
    check_run: z
      .object({
        id: z.union([z.number(), z.string()]),
        name: z.string().optional(),
        head_sha: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        app: z
          .object({
            id: z.union([z.number(), z.string()]).optional(),
            name: z.string().optional(),
            slug: z.string().optional(),
          })
          .passthrough()
          .optional(),
        pull_requests: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .passthrough()
      .optional(),
    check_suite: z
      .object({
        id: z.union([z.number(), z.string()]),
        head_sha: z.string().optional(),
        app: z
          .object({
            id: z.union([z.number(), z.string()]).optional(),
            name: z.string().optional(),
            slug: z.string().optional(),
          })
          .passthrough()
          .optional(),
        pull_requests: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .passthrough()
      .optional(),
    installation: z
      .object({
        id: z.union([z.number(), z.string()]),
      })
      .passthrough()
      .optional(),
    repositories: z.array(repoSchema).optional(),
    repositories_added: z.array(repoSchema).optional(),
    // Present on `installation_repositories` deliveries with action 'removed'.
    // Previously absent from the schema entirely, which is part of why that
    // action fell through to code expecting `repositories_added`.
    repositories_removed: z.array(repoSchema).optional(),
    sender: z
      .object({
        id: z.union([z.number(), z.string()]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Cap on how much of a Zod error is embedded in a thrown message. */
export const MAX_VALIDATION_ERROR_LENGTH = 500;

/**
 * Trim `text` so a failure reason stays a reasonable size.
 *
 * The formatted Zod error for a large webhook payload can run to many kilobytes,
 * and BullMQ writes the failure reason into Redis on every failed attempt.
 */
export function truncateForError(
  text: string,
  maxLength: number = MAX_VALIDATION_ERROR_LENGTH,
): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… (truncated, ${text.length} chars total)`;
}

/**
 * Re-exported from `@/lib/github/app-auth`, where they now live so the SBOM
 * and webhook helpers this module drives can read the App credentials without
 * importing back into it.
 */
export { WebhookConfigurationError, getGitHubAppCredentials } from "@/lib/github/app-auth";

export interface RepoLike {
  id: number | string;
  full_name: string;
  [key: string]: unknown;
}

export type RepositoryListIntent = "add" | "remove" | "ignore";

export interface RepositoryListSelection {
  intent: RepositoryListIntent;
  repositories: RepoLike[];
}

/**
 * Work out which repository list an installation-flavoured delivery carries.
 *
 * GitHub does not always send the field the old code assumed:
 *  - `installation` / 'created' normally carries `repositories`, but omits it in
 *    some selected-repository flows;
 *  - `installation_repositories` / 'added' carries `repositories_added`;
 *  - `installation_repositories` / 'removed' carries `repositories_removed`,
 *    which the old code did not handle at all;
 *  - `installation` / 'deleted' (the App was uninstalled) and 'suspend' carry
 *    the installation's `repositories`, which must stop being treated as
 *    active; 'unsuspend' carries the same list back. These were ignored, so an
 *    uninstalled App left every repository `isActive` on the dashboard and in
 *    analytics indefinitely.
 *
 * Returning an empty list rather than throwing means a delivery with nothing to
 * do is a no-op, not three retries and a DLQ entry.
 */
export function selectRepositoryList(
  event: string | null | undefined,
  action: string | null | undefined,
  payload: {
    repositories?: unknown;
    repositories_added?: unknown;
    repositories_removed?: unknown;
  },
): RepositoryListSelection {
  const asList = (value: unknown): RepoLike[] =>
    Array.isArray(value)
      ? (value.filter(
          (r) => r && typeof r === "object" && "id" in r && "full_name" in r,
        ) as RepoLike[])
      : [];

  if (event === "installation") {
    if (action === "created" || action === "unsuspend") {
      return { intent: "add", repositories: asList(payload.repositories) };
    }
    if (action === "deleted" || action === "suspend") {
      return { intent: "remove", repositories: asList(payload.repositories) };
    }
  }

  if (event === "installation_repositories") {
    if (action === "added") {
      return { intent: "add", repositories: asList(payload.repositories_added) };
    }
    if (action === "removed") {
      return { intent: "remove", repositories: asList(payload.repositories_removed) };
    }
  }

  return { intent: "ignore", repositories: [] };
}

/**
 * The name and owner a repository row should carry, from a webhook's repository.
 *
 * GitHub keeps a repository's numeric id across a rename or a transfer, so the
 * row is found by `githubId` either way — but the webhook paths only ever wrote
 * the name on create. Their upserts updated `isActive` alone and the PR path
 * never updated the row at all, so a renamed or transferred repository kept its
 * old `fullName` on the dashboard, in analytics, in audit rows and in every
 * scan's `repositoryFullName` until someone happened to run a manual sync
 * (`sync-user-repos.ts` already refreshes both fields). `userId` is
 * deliberately not part of this, for the reason given there (#657).
 */
export function repositoryIdentity(repo: { full_name: string; owner?: unknown }): {
  fullName: string;
  owner: string;
} {
  const login =
    repo.owner && typeof repo.owner === "object"
      ? (repo.owner as { login?: unknown }).login
      : undefined;
  return {
    fullName: repo.full_name,
    owner: typeof login === "string" && login !== "" ? login : repo.full_name.split("/")[0]!,
  };
}

export interface PullRequestContext {
  pullRequest: Record<string, any>;
  repository: Record<string, any>;
  ownerLogin: string;
  repoName: string;
  headSha: string;
  prNumber: number;
}

/**
 * Whether a delivery should also get a dependency (SBOM) scan of the manifests
 * it changes.
 *
 * Only `synchronize` — new commits on an existing pull request — which is the
 * trigger the webhook route used when it ran this inline. #927 moved every
 * delivery to this worker and dropped the route's call, so without this the
 * manifest scan had no caller at all.
 */
export function shouldScanPullRequestManifests(
  event: string | null | undefined,
  action: string | null | undefined,
): boolean {
  return (
    (event === "pull_request" && action === "synchronize") ||
    ((event === "check_run" || event === "check_suite") && action === "rerequested")
  );
}

/**
 * Assert that a `pull_request` delivery carries everything the handler needs.
 *
 * Every one of these fields is `.optional()` in the schema, so a partial payload
 * used to validate cleanly and then throw deep inside the handler — after the
 * pending PR comment had already been posted, leaving a permanent
 * "⏳ Evaluating..." comment that nothing ever updated.
 */
export function assertPullRequestContext(payload: {
  pull_request?: any;
  repository?: any;
}): PullRequestContext {
  const missing: string[] = [];

  const pullRequest = payload.pull_request;
  const repository = payload.repository;

  if (!pullRequest) missing.push("pull_request");
  if (!repository) missing.push("repository");

  const prNumber = pullRequest?.number;
  if (typeof prNumber !== "number") missing.push("pull_request.number");

  const headSha = pullRequest?.head?.sha;
  if (typeof headSha !== "string" || headSha === "") missing.push("pull_request.head.sha");

  // `name` is optional in the schema but always derivable from `full_name`.
  const repoName =
    typeof repository?.name === "string" && repository.name !== ""
      ? repository.name
      : typeof repository?.full_name === "string"
        ? repository.full_name.split("/")[1]
        : undefined;
  if (!repoName) missing.push("repository.name");

  const ownerLogin =
    typeof repository?.owner?.login === "string" && repository.owner.login !== ""
      ? repository.owner.login
      : typeof repository?.full_name === "string"
        ? repository.full_name.split("/")[0]
        : undefined;
  if (!ownerLogin) missing.push("repository.owner.login");

  if (missing.length > 0) {
    throw new Error(`Incomplete pull_request payload; missing: ${missing.join(", ")}`);
  }

  return {
    pullRequest,
    repository,
    ownerLogin: ownerLogin as string,
    repoName: repoName as string,
    headSha: headSha as string,
    prNumber: prNumber as number,
  };
}

/**
 * The set of new-file line numbers an inline review comment may anchor on.
 *
 * GitHub only accepts an inline comment on a line that appears in the diff
 * (added `+` lines or context lines); a comment on any other line is rejected
 * and fails the whole `pulls.createReview` call, taking every other comment in
 * the batch with it.
 *
 * This was a second, independent diff parser until #589. It disagreed with the
 * scanner's `extractAddedLines` on marker-less empty context lines, on `+++`
 * file headers and on the no-newline marker — so the line number the model was
 * shown was not always the line number this set contained, and findings were
 * either demoted to the summary body or anchored one line off. Both now read
 * the same walk in `@/lib/armor/diff`, which makes the disagreement structurally
 * impossible rather than fixed-for-now.
 */
/**
 * AI explanations requested at once for one pull request.
 *
 * Enrichment used `Promise.all(activeFindings.map(...))`, so a PR with forty
 * findings opened forty simultaneous completions against Groq. That is the
 * burst its per-minute limits reject; `withRetry` backs off, but every call is
 * retrying against the same limit at the same moment, and once the retries run
 * out the finding is stored — and posted on the PR — with the canned
 * "Groq API rate limit reached (429)" text in place of an explanation.
 */
export const AI_EXPLANATION_CONCURRENCY = 3;

export function getCommentableLines(patch: string): Set<number> {
  return commentableLineNumbers(parseUnifiedPatch(patch));
}

/**
 * Lease on the per-PR scan lock, renewed by a heartbeat while the scan runs.
 *
 * Deliberately short. A scan has no fixed upper bound (each LLM call may take up
 * to two minutes and is retried), so a flat lease long enough to outlast the
 * slowest one expires under a slow scan and lets a second job start on the same
 * PR, and it also keeps a PR blocked for that whole time after a worker crash.
 * With renewal the lease only has to outlast a missed heartbeat or two.
 */
const PR_SCAN_LOCK_TTL_MS = 60_000;
const PR_SCAN_LOCK_RENEW_MS = 20_000;

/** How long a job that lost the race for a PR waits before trying again. */
const PR_SCAN_LOCK_RETRY_DELAY_MS = 15_000;

export interface RunPullRequestScanParams {
  job: Job<WebhookJobData>;
  payload: any;
  pullRequest: any;
  repository: any;
  installation: any;
  event: string | undefined;
  action: string | undefined;
  deliveryId: string | undefined;
  correlationId: string;
  log: any;
  isRerun?: boolean;
  checkRunId?: number;
  parentContext?: Context;
}

export async function runPullRequestScan({
  job,
  payload,
  pullRequest,
  repository,
  installation,
  event,
  action,
  deliveryId,
  correlationId,
  log,
  isRerun = false,
  checkRunId,
  parentContext,
}: RunPullRequestScanParams): Promise<{ dbRepoId?: string; dbPrId?: string }> {
  let dbRepoId: string | undefined;
  let dbPrId: string | undefined;

  const lockKey = `pr-scan:${repository.full_name}:${pullRequest.number}`;
  const lockToken = await acquireLock(lockKey, PR_SCAN_LOCK_TTL_MS);
  if (!lockToken) {
    log.warn(
      `[Worker] PR #${pullRequest.number} on ${repository.full_name} is currently locked by a concurrent scan. Delaying job...`,
    );
    await job.moveToDelayed(Date.now() + PR_SCAN_LOCK_RETRY_DELAY_MS, job.token);
    throw new DelayedError();
  }

  // Keep the lease alive for as long as the scan actually runs.
  const lockHeartbeat = startLockHeartbeat(
    lockKey,
    lockToken,
    PR_SCAN_LOCK_TTL_MS,
    PR_SCAN_LOCK_RENEW_MS,
  );

  try {
    if (shouldScanPullRequestManifests(event, action)) {
      // Never throws (it logs and returns), so a manifest problem cannot
      // fail the code scan below. SBOM jobs are keyed by head SHA and file,
      // so a retry of this delivery does not enqueue them twice.
      await handlePullRequestSynchronize(
        {
          ...payload,
          number: pullRequest.number,
          pull_request: pullRequest,
          repository,
          installation,
        },
        deliveryId ?? undefined,
        correlationId,
      );
    }

    log.info(
      `Processing PR #${sanitize(pullRequest.number)} on ${sanitize(repository.full_name)}${isRerun ? " (manual re-run)" : ""}`,
    );

    let dbRepo = await prisma.repository.findUnique({
      where: { githubId: BigInt(repository.id) },
    });

    // FIX: Lazy-link the repository if it was missed during the initial installation
    if (!dbRepo) {
      const senderId = payload.sender?.id?.toString();
      const account = await prisma.account.findFirst({
        where: { provider: "github", providerAccountId: senderId },
      });

      if (account) {
        dbRepo = await prisma.repository.create({
          data: {
            githubId: BigInt(repository.id),
            fullName: repository.full_name,
            owner: repository.owner.login,
            userId: account.userId,
            isActive: true,
          },
        });
        log.info(
          `[Worker] Lazy-linked missing repository ${sanitize(repository.full_name)} to user ${sanitize(account.userId)}`,
        );
      }
    }

    if (dbRepo) {
      dbRepoId = dbRepo.id;
      const identity = repositoryIdentity(repository);
      if (dbRepo.fullName !== identity.fullName || dbRepo.owner !== identity.owner) {
        dbRepo = await prisma.repository.update({
          where: { id: dbRepo.id },
          data: identity,
        });
      }
    }

    const userId = dbRepo?.userId;

    // Use Redis-cached policy list to avoid two Prisma queries per scan.
    // Falls back to Prisma transparently when Redis is unavailable.
    let activePolicies: any[] = [];
    if (userId) {
      activePolicies = await getActivePoliciesForUser(userId);
    }

    if (userId) {
      await prisma.auditLog.create({
        data: sanitizeAuditLogInput({
          userId: userId,
          action: isRerun ? "Scan Re-run Triggered" : "Scan Triggered",
          resource: `${repository.full_name}#${pullRequest.number}`,
          metadata: {
            correlationId,
            deliveryId,
            action: action,
            head_sha: pullRequest.head?.sha,
            startedBy: isRerun ? "manual re-run" : undefined,
            trigger: isRerun ? "manual_rerun" : "webhook",
            checkRunId: checkRunId ?? undefined,
          },
        }),
      });
    }

    const { appId, privateKey, Octokit: customOctokit } = getGitHubAppCredentials();
    const appClient = new App({
      appId,
      privateKey,
      ...(customOctokit ? { Octokit: customOctokit } : {}),
    });
    const octokit = await appClient.getInstallationOctokit(installation.id);

    // Paginated: the endpoint defaults to 30 files per page, so an unpaginated
    // call left every file past the 30th unscanned while still reporting a
    // policy decision as though the whole PR had been reviewed.
    const pullRequestFilesResult = await withSpan(
      "diff.fetch",
      async (span) => {
        span.setAttribute("secureflow.correlation_id", correlationId);
        span.setAttribute("secureflow.repository_id", repository.full_name);
        span.setAttribute("secureflow.pr_number", pullRequest.number);
        if (pullRequest.head?.sha) span.setAttribute("secureflow.head_sha", pullRequest.head.sha);
        if (pullRequest.base?.ref) span.setAttribute("secureflow.base_ref", pullRequest.base.ref);

        const res = await fetchPullRequestFiles(octokit as any, {
          owner: repository.owner.login,
          repo: repository.name,
          pullNumber: pullRequest.number,
          changedFiles:
            typeof pullRequest.changed_files === "number" ? pullRequest.changed_files : null,
        });

        span.setAttribute("secureflow.changed_files_count", res.files.length);
        return res;
      },
      { parentContext },
    );

    const coverageNotice = formatCoverageNotice(pullRequestFilesResult);
    if (coverageNotice) {
      log.warn(
        `[Worker] Partial file coverage on ${sanitize(repository.full_name)}#${sanitize(pullRequest.number)}: analysed ${sanitize(pullRequestFilesResult.fetched)} of ${sanitize(pullRequestFilesResult.totalChanged ?? "unknown")} changed files.`,
      );
    }

    const fileChanges = pullRequestFilesResult.files
      .filter((file: any) => file.patch && file.status !== "removed")
      .map((file: any) => ({
        filename: file.filename,
        patch: file.patch,
      }));

    // Map each changed file to the set of new-file line numbers that are part of
    // the PR diff, so we only anchor inline review comments on commentable lines.
    const commentableLines = new Map<string, Set<number>>();
    for (const file of fileChanges) {
      commentableLines.set(file.filename, getCommentableLines(file.patch));
    }

    const pendingBody =
      `${SECUREFLOW_COMMENT_MARKER}\n### ⏳ SecureFlow AI Security Scan\n\n` +
      (pullRequest.head?.sha ? `Scanned commit: \`${pullRequest.head.sha}\`\n\n` : "") +
      `Evaluating **${fileChanges.length}** changed files. Please wait while the AI analyzes the code for potential vulnerabilities...` +
      (coverageNotice ? `\n\n${coverageNotice}` : "");

    const pendingComment = await upsertSecureFlowComment(octokit, {
      owner: repository.owner.login,
      repo: repository.name,
      issueNumber: pullRequest.number,
      body: pendingBody,
    });

    log.info(`[DEBUG] Passing ${sanitize(activePolicies.length)} active policies to scanEngine.`);
    const scanJobData: ScanJobData = {
      scanJobId: `webhook-${deliveryId || Date.now()}`,
      repositoryId: dbRepo?.id ?? "",
      installationId: installation.id,
      repositoryFullName: repository.full_name,
      prNumber: pullRequest.number,
      headSha: pullRequest.head?.sha,
      fileChanges,
      activePolicies,
      // Ignore rules are loaded by the scan engine from the base branch. They
      // were read here from `pull_request.head.sha`, the author's own commit,
      // which let a pull request switch off the scan of its own files.
      baseRef: pullRequest.base?.ref,
      customIgnores: [],
      customPlaceholders: [],
      userId,
      correlationId,
      deliveryId: deliveryId ?? null,
    };
    // Scanning only. This function posts its own check run and pull request
    // comment below, writes its own AuditLog row and creates its own
    // ScanResult, so letting the engine do the same would duplicate all four
    // (#747). It also requests the AI explanations itself, below, so the
    // engine must not request them first.
    const scanResult = await withSpan(
      "scan.execute",
      async (span) => {
        span.setAttribute("secureflow.correlation_id", correlationId);
        span.setAttribute("secureflow.repository_id", repository.full_name);
        span.setAttribute("secureflow.pr_number", pullRequest.number);
        if (pullRequest.head?.sha) span.setAttribute("secureflow.head_sha", pullRequest.head.sha);
        span.setAttribute("secureflow.files_scanned", fileChanges.length);

        const res = await processScanJob(scanJobData, undefined, {
          report: false,
          persist: false,
          enrich: false,
        });

        span.setAttribute("secureflow.findings_count", res.findings.length);
        span.setAttribute("secureflow.cache_hit", Boolean(res.reusedFromCache));
        return res;
      },
      { parentContext },
    );
    const findings = scanResult.findings;

    // Attach a stable content fingerprint to every finding so triage decisions
    // can be keyed off it and survive the latest-wins re-scan. When the repo
    // isn't in our DB there's nothing to triage against, so use an empty id.
    findings.forEach((f: any) => {
      f.fingerprint = computeFingerprint(dbRepo?.id ?? "", f.fileLocation, f.type, f.codeSnippet);
    });

    // Fingerprints the user has dismissed (false positive / ignored) for this
    // repo. These must not BLOCK the PR or inflate the risk score, even though
    // the scanner keeps re-detecting them on each push.
    const suppressedFingerprints = new Set<string>();
    if (dbRepo) {
      const dismissed = await prisma.findingTriage.findMany({
        where: {
          repositoryId: dbRepo.id,
          ...activeSuppressionWhere(new Date()),
        },
        select: { fingerprint: true },
      });
      dismissed.forEach((t: { fingerprint: string }) => suppressedFingerprints.add(t.fingerprint));
    }

    // Findings that still count toward enforcement — everything the user hasn't
    // dismissed. The full `findings` list is still persisted below (with its
    // fingerprint) so the dashboard can show dismissed items and left-join triage.
    const activeFindings = findings.filter((f: any) => !suppressedFingerprints.has(f.fingerprint));

    // Enrich and post ONLY the active findings: a finding the user dismissed
    // (FALSE_POSITIVE / IGNORED) must not be re-sent to the AI (wasted Groq
    // spend) nor re-posted as a PR comment on every re-scan.
    const enrichedFindings = await mapWithConcurrency(
      activeFindings,
      AI_EXPLANATION_CONCURRENCY,
      async (finding: any) => {
        const aiResponse = await withSpan(
          "llm.request",
          async (span) => {
            span.setAttribute("secureflow.correlation_id", correlationId);
            span.setAttribute("llm.finding_type", finding.type);
            span.setAttribute("llm.severity", finding.severity);
            return await developerReceivesAISecurityExplanations({
              findingType: finding.type,
              severity: finding.severity,
              description: finding.description,
              fileLocation: finding.fileLocation,
              codeSnippet: finding.codeSnippet || "",
            });
          },
          { parentContext },
        );
        return {
          ...finding,
          // Redacted before anything else touches them. These two fields are
          // generated after the scanner has finished, so they never passed
          // through maskSecrets — and they go straight into a pull request
          // comment and into Postgres. Remediation text is the worst case:
          // its natural shape is to quote the offending line back at you
          // ("move DB_PASSWORD=… into an environment variable"), and on a
          // public repository that comment is world-readable (#591).
          explanation: maskFindingText(aiResponse.explanation),
          remediation: maskFindingText(aiResponse.remediationSuggestions),
          // Layer 4 (UI surfacing): carry the injection flag through to the PR comment
          // and dashboard so reviewers are warned when the AI narrative may be unreliable.
          promptInjectionSuspected: aiResponse.promptInjectionSuspected,
        };
      },
    );

    // The full list is still persisted (active + dismissed) so the dashboard
    // can show dismissed items via the triage left-join. Dismissed findings
    // are stored as-is (no AI enrichment) — enrichment is reserved for the
    // active findings above.
    const suppressedFindings = findings.filter((f: any) =>
      suppressedFingerprints.has(f.fingerprint),
    );
    const findingsToPersist = [...enrichedFindings, ...suppressedFindings];

    // Load base-branch gate configuration
    const gateConfig = await loadTrustedGateConfig(octokit as unknown as IgnoreConfigClient, {
      owner: repository.owner.login,
      repo: repository.name,
      prNumber: pullRequest.number,
      baseRef: pullRequest.base?.ref,
    });

    const decision = iq.evaluateFindings(activeFindings, gateConfig);

    if (userId) {
      await prisma.auditLog.create({
        data: sanitizeAuditLogInput({
          userId: userId,
          action: scanResult.reusedFromCache
            ? "Policy Evaluation (reused from cache)"
            : "Policy Evaluation",
          resource: `${repository.full_name}#${pullRequest.number}`,
          decision: decision,
          metadata: {
            correlationId,
            deliveryId,
            findingsCount: activeFindings.length,
            suppressedCount: findings.length - activeFindings.length,
            reusedFromCache: scanResult.reusedFromCache ?? false,
            cacheHit: scanResult.reusedFromCache ?? false,
            cacheStatus: scanResult.reusedFromCache ? "reused from cache" : "fresh scan",
            trigger: isRerun ? "manual_rerun" : "webhook",
          },
        }),
      });
    }

    const gateSummary = formatGateSummaryLine(gateConfig);
    const combinedNotice = [gateSummary, coverageNotice].filter(Boolean).join("\n\n") || undefined;

    await withSpan(
      "check_run.update",
      async (span) => {
        span.setAttribute("secureflow.correlation_id", correlationId);
        span.setAttribute("secureflow.repository_id", repository.full_name);
        span.setAttribute("secureflow.pr_number", pullRequest.number);
        if (pullRequest.head?.sha) span.setAttribute("secureflow.head_sha", pullRequest.head.sha);
        if (checkRunId) span.setAttribute("secureflow.check_run_id", checkRunId);
        span.setAttribute("secureflow.decision", String(decision));
        span.setAttribute("secureflow.findings_count", activeFindings.length);

        return await postScanCheckRun(octokit as any, {
          owner: repository.owner.login,
          repo: repository.name,
          headSha: pullRequest.head?.sha,
          decision,
          findingsCount: activeFindings.length,
          fileCount: fileChanges.length,
          notice: combinedNotice,
          findings: enrichedFindings,
          checkRunId,
        });
      },
      { parentContext },
    );

    // Publish the same findings to GitHub's Code Scanning UI, so they show
    // up in the PR's "Security" tab without a trip to the dashboard.
    //
    // Deliberately after the check run and deliberately unable to fail the
    // scan: a private repository without Advanced Security answers 403 here,
    // which says nothing about the code that was just scanned. The upload is
    // built from `enrichedFindings` (active findings only) so a finding the
    // user dismissed does not reopen as an alert on the next push.
    //
    // The try/catch covers `buildSarifDocument` as well as the upload:
    // `uploadSarifAnalysis` guards its own request, but the document is
    // built here, and a throw from it would fail a scan job whose check run
    // has already been posted — turning a delivered result into a retry.
    try {
      const sarifOutcome = await uploadSarifAnalysis(octokit as unknown as CodeScanningClient, {
        owner: repository.owner.login,
        repo: repository.name,
        commitSha: pullRequest.head?.sha,
        ref: pullRequestRef(pullRequest.number),
        document: buildSarifDocument(enrichedFindings),
      });

      const target = `${sanitize(repository.full_name)}#${sanitize(String(pullRequest.number))}`;

      log.info(
        sarifOutcome.status === "uploaded"
          ? `[Worker] Uploaded SARIF for ${target}`
          : `[Worker] Skipped SARIF upload for ${target}: ${sanitize(sarifOutcome.reason)}`,
      );
    } catch (err) {
      log.info(
        `[Worker] SARIF upload errored for ${sanitize(repository.full_name)}: ${sanitize(
          err instanceof Error ? err.message : String(err),
        )}`,
      );
    }

    if (enrichedFindings.length > 0) {
      // Badge rendering comes from `@/lib/severity`. The previous inline
      // ternary only special-cased CRITICAL and HIGH, so LOW and NONE findings
      // were both labelled "🟡 MEDIUM" in the pull request comment — the report
      // overstated the severity of the least severe findings.

      // Resolve the diff line to anchor an inline comment on, or null when the
      // finding has no usable line inside the PR diff (GitHub would reject it).
      const anchorLine = (f: any): number | null => {
        if (typeof f.lineStart !== "number") return null;
        const lines = commentableLines.get(f.fileLocation);
        return lines && lines.has(f.lineStart) ? f.lineStart : null;
      };

      // Findings with a diff-anchored line become inline review comments; the
      // rest fall back into the summary body so nothing is ever lost.
      const inlineComments: { path: string; line: number; body: string }[] = [];
      const summaryFindings: any[] = [];

      enrichedFindings.forEach((f: any) => {
        const line = anchorLine(f);
        if (line !== null) {
          inlineComments.push({
            path: f.fileLocation,
            line,
            body:
              `**${severityBadge(f.severity)} · ${f.type}**\n\n` +
              // Layer 4: surface injection warning on the individual inline comment when flagged.
              (f.promptInjectionSuspected
                ? `> ⚠️ **AI explanation may be unreliable for this finding — verify manually.** The code snippet associated with this finding triggered prompt-injection heuristics or produced a severity-inconsistent response. Trust the ${severityBadge(f.severity)} badge from the static scanner above the AI narrative.\n\n`
                : "") +
              `${f.explanation}\n\n` +
              `<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>\n\n` +
              `${f.remediation}\n\n</details>`,
          });
        } else {
          summaryFindings.push(f);
        }
      });

      const renderSummary = (findingsToRender: any[]) =>
        renderScanReportSummary({
          findings: findingsToRender,
          totalFindings: enrichedFindings.length,
          inlineCount: inlineComments.length,
          coverageNotice,
          suppressedFindings: scanner.lastSuppressionResult?.suppressedFindings,
          rejectedSuppressions: scanner.lastSuppressionResult?.rejectedSuppressions,
          previouslyDismissedCount: suppressedFindings.length,
          commitSha: pullRequest.head?.sha,
          expiredIgnoreRules: scanResult.expiredIgnoreRules,
        });

      // Try to post the anchored findings as an inline review. If that fails
      // (e.g. a line slipped past the guard), fall back to a summary comment
      // that contains every finding so a bad line never breaks the webhook.
      let inlinePosted = false;
      if (inlineComments.length > 0) {
        try {
          await octokit.rest.pulls.createReview({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: pullRequest.number,
            commit_id: pullRequest.head?.sha,
            event: "COMMENT",
            body: renderSummary(summaryFindings),
            comments: inlineComments,
          });
          inlinePosted = true;
        } catch (err: any) {
          log.error(
            `[REVIEW] Failed to post inline review comments, falling back to summary comment: ${sanitize(err.message)}`,
            { error: err?.message },
          );
        }
      }

      await upsertSecureFlowComment(octokit, {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: pullRequest.number,
        commentId: pendingComment.data.id,
        // When inline posting succeeded, the pending comment only needs the
        // non-anchored findings; otherwise it carries the full report.
        body: renderSummary(inlinePosted ? summaryFindings : enrichedFindings),
      });

      if (userId) {
        await prisma.auditLog.create({
          data: sanitizeAuditLogInput({
            userId: userId,
            action: "PR Comment Posted",
            resource: `${repository.full_name}#${pullRequest.number}`,
            metadata: {
              correlationId,
              deliveryId,
              commentType: "AI Security Report",
              findingsReported: enrichedFindings.length,
              inlineComments: inlinePosted ? inlineComments.length : 0,
            },
          }),
        });
      }
    } else {
      const cleanDismissedNotice =
        suppressedFindings.length > 0
          ? `\n\n🛡️ **${suppressedFindings.length} previously dismissed** finding(s) were suppressed for this repository.`
          : "";

      const cleanExpiredNotice =
        scanResult.expiredIgnoreRules && scanResult.expiredIgnoreRules.length > 0
          ? `\n\n### ⚠️ Expired Ignore Rules (${scanResult.expiredIgnoreRules.length})\n\n` +
            scanResult.expiredIgnoreRules
              .map(
                (r) =>
                  `- ⚠️ ignore rule \`${r.pattern}\` expired on ${r.expires}${
                    r.reason ? ` — reason: ${r.reason}` : ""
                  }`,
              )
              .join("\n")
          : "";

      const cleanBody =
        `${SECUREFLOW_COMMENT_MARKER}\n### 🛡️ SecureFlow AI Security Report\n\n` +
        (pullRequest.head?.sha ? `Scanned commit: \`${pullRequest.head.sha}\`\n\n` : "") +
        `✅ Scan completed successfully. No vulnerabilities found in the **${fileChanges.length}** analyzed files.` +
        cleanDismissedNotice +
        cleanExpiredNotice +
        // A clean result on a partial scan must say so — this is exactly the
        // case where silent truncation was most misleading.
        (coverageNotice ? `\n\n${coverageNotice}` : "");

      await upsertSecureFlowComment(octokit, {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: pullRequest.number,
        commentId: pendingComment.data.id,
        body: cleanBody,
      });
    }

    if (dbRepo) {
      // Authorship is written on both halves. `create` is the obvious one;
      // `update` is what matters more right now, because every row this
      // worker has already written has `authorLogin = NULL`, and
      // `aggregateContributors` scopes all eight of its queries with
      // `{ authorLogin: { not: null } }`. Without the update those rows stay
      // invisible to the leaderboard forever rather than being backfilled by
      // the next push (#702, and the reported symptom in #696).
      //
      // `state` comes from `buildPullRequestFacts`, not from
      // `normalizePrStateEnum(pull_request.state)`: GitHub only ever sets
      // that field to "open" or "closed", so the old call could not produce
      // MERGED for any payload at all.
      const prFacts = buildPullRequestFacts(pullRequest);
      const dbPr = await prisma.pullRequest.upsert({
        where: { githubId: BigInt(pullRequest.id) },
        update: {
          ...pullRequestUpdateData(prFacts),
          status: normalizePrStatusEnum(decision),
        },
        create: {
          githubId: BigInt(pullRequest.id),
          prNumber: pullRequest.number,
          title: prFacts.title,
          state: prFacts.state,
          status: normalizePrStatusEnum(decision),
          authorLogin: prFacts.authorLogin,
          authorAvatarUrl: prFacts.authorAvatarUrl,
          repositoryId: dbRepo.id,
        },
      });

      dbPrId = dbPr.id; // Capture the DB ID for the lock record

      // Risk score ignores dismissed findings so triaged-away issues stop
      // counting toward the stored score (and the risk-trend average).
      const riskScore = totalRiskScore(activeFindings as Array<{ severity: unknown }>);

      await withSpan(
        "db.write",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.repository_id", repository.full_name);
          span.setAttribute("secureflow.pr_number", pullRequest.number);
          if (pullRequest.head?.sha) span.setAttribute("secureflow.head_sha", pullRequest.head.sha);
          span.setAttribute("secureflow.findings_persisted", findingsToPersist.length);
          span.setAttribute("secureflow.risk_score", riskScore);
          span.setAttribute("secureflow.policy_decision", normalizePolicyDecisionEnum(decision));

          return await prisma.scanResult.create({
            data: {
              pullRequestId: dbPr.id,
              headSha: pullRequest.head?.sha,
              gateConfig,
              riskScore,
              policyDecision: normalizePolicyDecisionEnum(decision),
              findings: {
                create: findingsToPersist.map((f: any) => ({
                  type: normalizeFindingTypeEnum(f.type),
                  // `toStoredSeverity`, not `normalizeSeverity`: the latter can return
                  // 'NONE' (for a scanner answer of clean/pass/ok/unknown) and 'NONE' is
                  // not a `FindingSeverity` member, so the insert fails outright (#686).
                  severity: toStoredSeverity(f.severity),
                  fileLocation: f.fileLocation,
                  lineStart: typeof f.lineStart === "number" ? f.lineStart : null,
                  lineEnd: typeof f.lineEnd === "number" ? f.lineEnd : null,
                  codeSnippet: f.codeSnippet || null,
                  explanation: f.explanation || null,
                  remediation: f.remediation || null,
                  promptInjectionSuspected: Boolean(f.promptInjectionSuspected),
                  fingerprint: f.fingerprint || "",
                })),
              },
            },
          });
        },
        { parentContext },
      );

      // Auto-resolve open findings from earlier scans of this PR that are now gone (#1869)
      const isPartialScan =
        Boolean(coverageNotice) ||
        Boolean(scanner.lastSkippedFiles && scanner.lastSkippedFiles.length > 0);
      await autoResolveFixedFindings({
        repositoryId: (dbRepo?.id || repository.id).toString(),
        pullRequestId: dbPr.id,
        headSha: pullRequest.head?.sha,
        currentFindings: findings,
        fileChanges,
        isPartialScan,
        userId,
        repoFullName: repository.full_name,
      }).catch((err: any) => {
        log.warn(
          `[WORKER] Failed to auto-resolve fixed findings: ${sanitize(err?.message || String(err))}`,
        );
      });

      // Real-time Slack alert for CRITICAL/HIGH findings (#936). Best-effort
      // and non-throwing, so a Slack outage cannot fail the webhook job or
      // trigger a BullMQ retry of an already-persisted scan. The severity
      // threshold is applied inside the integration.
      if (userId && enrichedFindings.length > 0) {
        try {
          const owner = await prisma.user.findUnique({
            where: { id: userId },
            select: { slackWebhookUrl: true },
          });

          await notifyHighSeverityFindings(owner?.slackWebhookUrl, {
            repositoryFullName: repository.full_name,
            prNumber: pullRequest.number,
            findings: enrichedFindings,
          });

          if (decision === "BLOCKED") {
            await notifyBlockedScan({
              scanJobId: `webhook-${deliveryId || Date.now()}`,
              deliveryId,
              correlationId,
              userId,
              repositoryFullName: repository.full_name,
              prNumber: pullRequest.number,
              findings: enrichedFindings,
              decision,
            });
          }
        } catch (err) {
          log.error(`[Worker] Slack notification step failed:`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Dispatch generic outbound webhooks (#1866)
        try {
          const commitSha = pullRequest.head?.sha ?? "";
          await dispatchOutboundWebhooksForUser(userId, "scan.completed", () =>
            buildScanCompletedPayload({
              repository: repository.full_name,
              prNumber: pullRequest.number,
              commitSha,
              decision,
              findings: enrichedFindings,
            }),
          );

          if (decision === "BLOCKED") {
            await dispatchOutboundWebhooksForUser(userId, "scan.blocked", () =>
              buildScanBlockedPayload({
                repository: repository.full_name,
                prNumber: pullRequest.number,
                commitSha,
                decision,
                findings: enrichedFindings,
              }),
            );
          }

          for (const finding of enrichedFindings) {
            await dispatchOutboundWebhooksForUser(userId, "finding.created", () =>
              buildFindingCreatedPayload({
                repository: repository.full_name,
                prNumber: pullRequest.number,
                commitSha,
                finding,
              }),
            );
          }
        } catch (whErr) {
          log.error("[Worker] Outbound webhook dispatch failed:", {
            error: whErr instanceof Error ? whErr.message : String(whErr),
          });
        }
      }

      // Real-time voice alert for CRITICAL/HIGH findings (#1307). Best-effort,
      // non-throwing so a Redis failure cannot retry an already-persisted scan.
      if (userId && enrichedFindings.length > 0) {
        const topSeverityFinding =
          enrichedFindings.find((f: any) => f.severity === "CRITICAL") ??
          enrichedFindings.find((f: any) => f.severity === "HIGH");
        if (topSeverityFinding) {
          publishVoiceAlert(userId, {
            repositoryFullName: repository.full_name,
            prNumber: pullRequest.number,
            decision: decision === "BLOCKED" ? "BLOCK" : "REVIEW",
            topSeverity: topSeverityFinding.severity,
            alertId: deliveryId ?? crypto.randomUUID(),
          }).catch((err: unknown) =>
            log.error("[Worker] Voice alert publish failed:", { error: String(err) }),
          );
        }
      }
    }
  } finally {
    // Stop renewing before releasing, so a late renewal cannot run after
    // the lock has been handed on.
    lockHeartbeat.stop();
    await releaseLock(lockKey, lockToken);
  }

  return { dbRepoId, dbPrId };
}

export const worker = new Worker<WebhookJobData>(
  "github-webhooks",
  async (job: Job<WebhookJobData>) => {
    const { payload: rawPayload, event, deliveryId } = job.data;
    const correlationId = job.data.correlationId || deliveryId || crypto.randomUUID();
    const log = logger.child({ correlationId, deliveryId: deliveryId ?? undefined, jobId: job.id });

    // Extract OpenTelemetry trace context from the queue job payload
    const parentContext = extractTraceContext(job.data.traceContext);

    // Record queue wait span if the job was queued
    if (job.timestamp) {
      await withSpan(
        "queue.wait",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.queue", "github-webhooks");
          if (job.id) span.setAttribute("secureflow.job_id", String(job.id));
          span.setAttribute("secureflow.wait_ms", Math.max(0, Date.now() - job.timestamp));
        },
        { parentContext, startTime: job.timestamp },
      );
    }

    // Event Filtering
    if (
      ![
        "pull_request",
        "merge_group",
        "installation",
        "installation_repositories",
        "branch_protection_rule",
        "check_run",
        "check_suite",
      ].includes(event || "")
    ) {
      log.info(`Event not tracked: ${sanitize(event)}`);
      return;
    }

    // 2. Validate Payload
    const parsed = payloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new Error(
        `Invalid payload structure: ${truncateForError(JSON.stringify(parsed.error.format()))}`,
      );
    }
    const payload = parsed.data;

    // 3. Check Idempotency FIRST (Do not write until job completes)
    if (deliveryId) {
      const existingEvent = await prisma.webhookEvent.findUnique({
        where: { deliveryId },
      });

      if (existingEvent) {
        log.info(`[Worker] Webhook ${sanitize(deliveryId)} already processed. Skipping.`);
        return;
      }
    }

    // Destructure validated payload properties for processing
    const { action, pull_request, repository, installation } = payload as any;

    // Resolved once here so every installation-flavoured branch reads the same
    // field, including the 'removed' action the old code never handled.
    const repoSelection = selectRepositoryList(event, action, payload as any);

    if (!installation || !installation.id) {
      throw new Error("No GitHub App installation ID found");
    }

    // Extract metadata for the idempotency lock
    let dbRepoId: string | undefined;
    let dbPrId: string | undefined;

    if (repository?.id) {
      const dbRepo = await prisma.repository.findUnique({
        where: { githubId: BigInt(repository.id) },
      });
      if (dbRepo) dbRepoId = dbRepo.id;
    }

    if (pull_request?.id) {
      const dbPr = await prisma.pullRequest.findUnique({
        where: { githubId: BigInt(pull_request.id) },
      });
      if (dbPr) dbPrId = dbPr.id;
    }

    // === EXECUTION PHASE ===
    if (event === "installation" && action === "created") {
      const senderId = payload.sender?.id?.toString();
      const account = await prisma.account.findFirst({
        where: { provider: "github", providerAccountId: senderId },
      });

      if (!account) {
        log.info(
          `Webhook received installation for unknown user ${sanitize(senderId)}. Awaiting Setup URL redirect linking.`,
        );
        return; // Safe to return early here; user hasn't set up yet so we shouldn't lock the webhook.
      }

      // GitHub omits `repositories` from some selected-repository install flows.
      // The old code called .map() on it unconditionally and threw a TypeError,
      // burning three retries before landing a valid delivery in the DLQ.
      if (repoSelection.repositories.length === 0) {
        log.info("[Worker] Installation delivery carried no repositories; nothing to link.");
      } else {
        await prisma.$transaction([
          ...repoSelection.repositories.map((repo) =>
            prisma.repository.upsert({
              where: { githubId: BigInt(repo.id) },
              update: { isActive: true, ...repositoryIdentity(repo) },
              create: {
                githubId: BigInt(repo.id),
                ...repositoryIdentity(repo),
                userId: account.userId,
              },
            }),
          ),
          prisma.auditLog.create({
            data: sanitizeAuditLogInput({
              userId: account.userId,
              action: "Repository Added",
              resource: repoSelection.repositories.map((r) => r.full_name).join(", "),
              metadata: {
                correlationId,
                deliveryId,
                count: repoSelection.repositories.length,
                event: "installation",
              },
            }),
          }),
        ]);
        log.info(
          `Successfully installed app and populated ${repoSelection.repositories.length} repositories.`,
        );
      }
    } else if (
      (event === "installation_repositories" && (action === "added" || action === "removed")) ||
      (event === "installation" &&
        (action === "deleted" || action === "suspend" || action === "unsuspend"))
    ) {
      const senderId = payload.sender?.id?.toString();
      const account = await prisma.account.findFirst({
        where: { provider: "github", providerAccountId: senderId },
      });

      if (!account) {
        log.info(
          `[Worker] installation_repositories for unknown user ${sanitize(senderId)}; skipping.`,
        );
      } else if (repoSelection.repositories.length === 0) {
        log.info(
          `[Worker] installation_repositories '${sanitize(action)}' carried no repositories; nothing to do.`,
        );
      } else if (repoSelection.intent === "remove") {
        // 'removed' deliveries were previously routed into the 'added' branch's
        // shape and threw on the missing `repositories_added` field. Repositories
        // are deactivated rather than deleted so their scan history survives.
        await prisma.$transaction([
          prisma.repository.updateMany({
            where: { githubId: { in: repoSelection.repositories.map((r) => BigInt(r.id)) } },
            data: { isActive: false },
          }),
          prisma.auditLog.create({
            data: sanitizeAuditLogInput({
              userId: account.userId,
              action: "Repository Removed",
              resource: repoSelection.repositories.map((r) => r.full_name).join(", "),
              metadata: {
                correlationId,
                deliveryId,
                count: repoSelection.repositories.length,
                event,
              },
            }),
          }),
        ]);
      } else {
        await prisma.$transaction([
          ...repoSelection.repositories.map((repo) =>
            prisma.repository.upsert({
              where: { githubId: BigInt(repo.id) },
              update: { isActive: true, ...repositoryIdentity(repo) },
              create: {
                githubId: BigInt(repo.id),
                ...repositoryIdentity(repo),
                userId: account.userId,
              },
            }),
          ),
          prisma.auditLog.create({
            data: sanitizeAuditLogInput({
              userId: account.userId,
              action: "Repository Added",
              resource: repoSelection.repositories.map((r) => r.full_name).join(", "),
              metadata: {
                correlationId,
                deliveryId,
                count: repoSelection.repositories.length,
                event,
              },
            }),
          }),
        ]);
      }
    } else if (event === "pull_request") {
      const actionKind = classifyPullRequestAction(action);

      // The facts about the pull request itself, as opposed to the findings. Both
      // branches below write them, because both branches learn something worth
      // storing — the metadata branch exists precisely so a merge is not thrown
      // away just because there is no new code to scan (#702).
      const prFacts = buildPullRequestFacts(pull_request);

      if (actionKind === "ignore") {
        log.info(`Action not tracked: ${sanitize(action)}`);
      } else if (actionKind === "metadata") {
        // No new head commit, so no scan: re-running the pipeline here would cost
        // a Groq call and post a second review on a pull request that is already
        // closed. But `closed` is the only delivery that can tell us a pull
        // request was *merged*, and the old filter dropped it — which is why
        // every stored row was `state: OPEN` forever and the leaderboard's
        // extraction count was structurally zero.
        //
        // `updateMany` rather than `upsert`: if we never scanned this pull
        // request there is no row, and inventing one would give it the default
        // `status: REVIEW_REQUIRED` and drag down its author's pass rate on the
        // strength of a policy evaluation that never ran.
        if (pull_request?.id) {
          const { count } = await prisma.pullRequest.updateMany({
            where: { githubId: BigInt(pull_request.id) },
            data: pullRequestUpdateData(prFacts),
          });

          log.info(
            count > 0
              ? `[Worker] Recorded '${sanitize(action)}' for PR #${sanitize(pull_request.number)} as ${sanitize(prFacts.state)}.`
              : `[Worker] '${sanitize(action)}' for PR #${sanitize(pull_request.number)} refers to a pull request we never scanned; nothing to update.`,
          );
        }
      } else {
        assertPullRequestContext(payload as any);
        const resultIds = await runPullRequestScan({
          job,
          payload,
          pullRequest: pull_request,
          repository,
          installation,
          event,
          action,
          deliveryId: deliveryId ?? undefined,
          correlationId,
          log,
          isRerun: false,
          parentContext,
        });
        if (resultIds.dbRepoId) dbRepoId = resultIds.dbRepoId;
        if (resultIds.dbPrId) dbPrId = resultIds.dbPrId;
      }
    } else if (event === "check_run" || event === "check_suite") {
      if (action !== "rerequested") {
        log.info(`Action not tracked for ${sanitize(event)}: ${sanitize(action)}`);
        return;
      }

      const { appId } = getGitHubAppCredentials();
      if (event === "check_run" && !isSecureFlowCheckRun(payload.check_run, appId)) {
        log.info("Check run not created by SecureFlow ignored");
        return;
      }
      if (event === "check_suite" && !isSecureFlowCheckSuite(payload.check_suite, appId)) {
        log.info("Check suite not created by SecureFlow ignored");
        return;
      }

      const attachedPrs =
        (event === "check_run"
          ? payload.check_run?.pull_requests
          : payload.check_suite?.pull_requests) ?? [];

      if (!Array.isArray(attachedPrs) || attachedPrs.length === 0) {
        log.info(
          `[Worker] ${sanitize(event)} rerequested has no attached pull requests to scan; skipping.`,
        );
        return;
      }

      const checkRunId =
        event === "check_run" && payload.check_run?.id ? Number(payload.check_run.id) : undefined;

      for (const pr of attachedPrs) {
        const prAny = pr as Record<string, any>;
        const prNumber = typeof prAny.number === "number" ? prAny.number : Number(prAny.number);
        if (!Number.isFinite(prNumber)) continue;

        const headSha =
          prAny.head?.sha ??
          (event === "check_run" ? payload.check_run?.head_sha : payload.check_suite?.head_sha);
        if (!headSha) {
          log.warn(
            `[Worker] Missing headSha for PR #${prNumber} on ${sanitize(repository?.full_name)}`,
          );
          continue;
        }

        let prId = prAny.id;
        if (!prId && dbRepoId) {
          const existingPr = await prisma.pullRequest.findFirst({
            where: { repositoryId: dbRepoId, prNumber },
          });
          if (existingPr) {
            prId = existingPr.githubId;
          }
        }
        if (!prId) {
          prId = prNumber;
        }

        const normalizedPr = {
          ...prAny,
          id: prId,
          number: prNumber,
          head: {
            sha: headSha,
            ref: prAny.head?.ref,
          },
          base: {
            ref: prAny.base?.ref,
            sha: prAny.base?.sha,
          },
        };

        const resultIds = await runPullRequestScan({
          job,
          payload: { ...payload, pull_request: normalizedPr },
          pullRequest: normalizedPr,
          repository,
          installation,
          event,
          action,
          deliveryId: deliveryId ?? undefined,
          correlationId,
          log,
          isRerun: true,
          checkRunId,
          parentContext,
        });

        if (resultIds.dbRepoId) dbRepoId = resultIds.dbRepoId;
        if (resultIds.dbPrId) dbPrId = resultIds.dbPrId;
      }
    } else if (event === "merge_group") {
      if (action !== "checks_requested") {
        log.info(`Action not tracked for merge_group: ${sanitize(action)}`);
        return;
      }

      const mergeGroup = payload.merge_group;
      if (!mergeGroup?.head_sha) {
        log.warn("[Worker] Incomplete merge_group payload: missing head_sha");
        return;
      }

      const headSha = mergeGroup.head_sha;
      const baseSha = mergeGroup.base_sha;
      const baseRef = mergeGroup.base_ref?.replace(/^refs\/heads\//, "") || "main";

      const repoFullName = repository?.full_name || "unknown";
      const repoOwner =
        repository?.owner?.login ||
        (repository?.full_name ? repository.full_name.split("/")[0] : "");
      const repoName =
        repository?.name || (repository?.full_name ? repository.full_name.split("/")[1] : "");

      const lockKey = `merge-group-scan:${repoFullName}:${headSha}`;
      const lockToken = await acquireLock(lockKey, PR_SCAN_LOCK_TTL_MS);
      if (!lockToken) {
        log.warn(
          `[Worker] merge_group ${headSha} on ${repoFullName} is currently locked by a concurrent scan. Delaying job...`,
        );
        await job.moveToDelayed(Date.now() + PR_SCAN_LOCK_RETRY_DELAY_MS, job.token);
        throw new DelayedError();
      }

      const lockHeartbeat = startLockHeartbeat(
        lockKey,
        lockToken,
        PR_SCAN_LOCK_TTL_MS,
        PR_SCAN_LOCK_RENEW_MS,
      );

      try {
        let dbRepo = repository?.id
          ? await prisma.repository.findUnique({
              where: { githubId: BigInt(repository.id) },
            })
          : null;

        if (!dbRepo && repository?.id) {
          const senderId = payload.sender?.id?.toString();
          const account = await prisma.account.findFirst({
            where: { provider: "github", providerAccountId: senderId },
          });

          if (account) {
            dbRepo = await prisma.repository.create({
              data: {
                githubId: BigInt(repository.id),
                fullName: repository.full_name,
                owner: repoOwner,
                userId: account.userId,
                isActive: true,
              },
            });
            log.info(
              `[Worker] Lazy-linked missing repository ${sanitize(repository.full_name)} to user ${sanitize(account.userId)}`,
            );
          }
        }

        if (dbRepo) {
          dbRepoId = dbRepo.id;
        }

        const userId = dbRepo?.userId;

        const { appId, privateKey, Octokit: customOctokit } = getGitHubAppCredentials();
        const appClient = new App({
          appId,
          privateKey,
          ...(customOctokit ? { Octokit: customOctokit } : {}),
        });
        const octokit = await appClient.getInstallationOctokit(Number(installation.id));

        const prNumber = extractPrNumberFromMergeGroup(mergeGroup);

        // Base-branch gate configuration
        const gateConfig = await loadTrustedGateConfig(octokit as unknown as IgnoreConfigClient, {
          owner: repoOwner,
          repo: repoName,
          prNumber: prNumber ?? 0,
          baseRef,
        });

        // 1. Fetch merge group combined diff files
        let mergeGroupFiles: { filename: string; patch: string }[] = [];
        if (baseSha && headSha) {
          try {
            mergeGroupFiles = await fetchMergeGroupFiles(octokit as any, {
              owner: repoOwner,
              repo: repoName,
              baseSha,
              headSha,
            });
          } catch (err) {
            log.warn(
              `[Worker] Failed to compareCommits for merge_group ${baseSha}...${headSha}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // 2. Check if merged diff content matches PR scan
        let isDiffUnchanged = false;
        let reusedScan: {
          decision: string;
          findingsCount: number;
          findings: any[];
        } | null = null;

        if (prNumber) {
          try {
            const prFilesResult = await fetchPullRequestFiles(octokit as any, {
              owner: repoOwner,
              repo: repoName,
              pullNumber: prNumber,
            });
            const prFiles = prFilesResult.files
              .filter((f: any) => f.patch && f.status !== "removed")
              .map((f: any) => ({ filename: f.filename, patch: f.patch }));

            if (isMergeGroupDiffUnchanged(mergeGroupFiles, prFiles)) {
              isDiffUnchanged = true;
              if (dbRepo) {
                const dbPr = await prisma.pullRequest.findFirst({
                  where: { repositoryId: dbRepo.id, prNumber },
                  include: {
                    scans: {
                      orderBy: { createdAt: "desc" },
                      take: 1,
                      include: { findings: true },
                    },
                  },
                });

                if (dbPr?.scans[0]) {
                  dbPrId = dbPr.id;
                  const lastScan = dbPr.scans[0];
                  const mappedDecision =
                    lastScan.policyDecision === "PASS"
                      ? "PASS"
                      : lastScan.policyDecision === "BLOCK"
                        ? "BLOCKED"
                        : "REVIEW REQUIRED";

                  reusedScan = {
                    decision: mappedDecision,
                    findingsCount: lastScan.findings.length,
                    findings: lastScan.findings,
                  };
                }
              }
            }
          } catch (err) {
            log.warn(
              `[Worker] Failed checking PR #${prNumber} files for diff comparison: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        let decision: string;
        let findingsCount: number;
        let findingsToReport: any[] = [];
        let appliedPolicyScopes:
          | Array<{
              paths: string[];
              enable?: string[];
              disable?: string[];
              matchedFiles: string[];
              fileCount: number;
            }>
          | undefined;

        if (isDiffUnchanged && reusedScan) {
          log.info(
            `[Worker] Merge group diff unchanged for PR #${prNumber}; reusing PR scan decision: ${reusedScan.decision}`,
          );
          decision = reusedScan.decision;
          findingsCount = reusedScan.findingsCount;
          findingsToReport = reusedScan.findings;
        } else {
          log.info(
            `[Worker] Scanning combined diff for merge group ${headSha} (${mergeGroupFiles.length} changed files)`,
          );

          let activePolicies: any[] = [];
          if (userId) {
            activePolicies = await getActivePoliciesForUser(userId);
          }

          const scanJobData: ScanJobData = {
            scanJobId: `merge-group-${deliveryId || Date.now()}`,
            repositoryId: dbRepo?.id ?? "",
            installationId: installation.id,
            repositoryFullName: repository.full_name,
            prNumber: prNumber ?? 0,
            headSha,
            fileChanges: mergeGroupFiles,
            activePolicies,
            baseRef,
            customIgnores: [],
            customPlaceholders: [],
            userId,
            correlationId,
            deliveryId: deliveryId ?? null,
          };

          const scanResult = await processScanJob(scanJobData, undefined, {
            report: false,
            persist: false,
            enrich: false,
          });

          const suppressedFingerprints = new Set<string>();
          if (dbRepo) {
            const dismissed = await prisma.findingTriage.findMany({
              where: {
                repositoryId: dbRepo.id,
                ...activeSuppressionWhere(new Date()),
              },
              select: { fingerprint: true },
            });
            dismissed.forEach((t: { fingerprint: string }) =>
              suppressedFingerprints.add(t.fingerprint),
            );
          }

          const activeFindings = scanResult.findings.filter(
            (f: any) => !suppressedFingerprints.has(f.fingerprint),
          );

          decision = iq.evaluateFindings(activeFindings, gateConfig);
          findingsCount = activeFindings.length;
          findingsToReport = activeFindings;
          appliedPolicyScopes = scanResult.appliedPolicyScopes?.map((s) => ({
            paths: s.scope.paths,
            enable: s.scope.enable,
            disable: s.scope.disable,
            matchedFiles: s.matchedFiles,
            fileCount: s.matchedFiles.length,
          }));
        }

        const gateSummary = formatGateSummaryLine(gateConfig);
        const scopesNotice =
          appliedPolicyScopes && appliedPolicyScopes.length > 0
            ? formatAppliedScopesSection(
                appliedPolicyScopes.map((s) => ({
                  scope: { paths: s.paths, enable: s.enable, disable: s.disable },
                  matchedFiles: s.matchedFiles,
                })),
              )
            : undefined;
        const notice =
          [
            isDiffUnchanged && prNumber
              ? `Reused scan result from PR #${prNumber} (merge diff unchanged).`
              : "Evaluated combined merge group diff.",
            gateSummary,
            scopesNotice,
          ]
            .filter(Boolean)
            .join("\n\n") || undefined;

        await postScanCheckRun(octokit as any, {
          owner: repoOwner,
          repo: repoName,
          headSha,
          decision,
          findingsCount,
          fileCount: mergeGroupFiles.length,
          notice,
          findings: findingsToReport,
        });

        if (userId) {
          await prisma.auditLog.create({
            data: sanitizeAuditLogInput({
              userId,
              action: isDiffUnchanged
                ? "Merge Group Evaluation (reused from PR)"
                : "Merge Group Evaluation",
              resource: `${repository.full_name}#${headSha.slice(0, 7)}`,
              decision,
              metadata: {
                correlationId,
                deliveryId,
                head_sha: headSha,
                base_sha: baseSha,
                prNumber,
                reusedFromPr: isDiffUnchanged,
              },
            }),
          });
        }
      } finally {
        lockHeartbeat.stop();
        await releaseLock(lockKey, lockToken);
      }
    }

    // 4. LOCK: Mark the webhook as processed now that everything succeeded
    if (deliveryId) {
      await prisma.webhookEvent.create({
        data: {
          deliveryId,
          repositoryId: dbRepoId,
          pullRequestId: dbPrId,
        },
      });
      log.info(`[Worker] Successfully processed and cached webhook ${deliveryId}`);
    }
  },
  { connection: redis as any },
);

/**
 * Fail-closed: when a pull_request scan fails permanently, post a failing
 * "SecureFlow Scan" check so the PR cannot merge as if it had been scanned.
 *
 * Never throws: a failure here must not disturb DLQ routing. The reason is a
 * fixed string on purpose, because the check output is visible on the PR and
 * an internal error message (DB host, stack detail) must not end up there.
 */
export async function postScanFailureCheck(
  data: WebhookJobData | undefined,
  correlationId?: string,
): Promise<void> {
  const effectiveCorrelationId = correlationId || data?.correlationId;
  const log = effectiveCorrelationId
    ? logger.child({ correlationId: effectiveCorrelationId })
    : logger;

  try {
    if (
      !data ||
      (data.event !== "pull_request" &&
        data.event !== "merge_group" &&
        data.event !== "check_run" &&
        data.event !== "check_suite")
    ) {
      return;
    }

    const payload = data.payload as any;

    if (data.event === "pull_request") {
      // Only deliveries that actually trigger a scan; "closed" etc. never posted a check.
      const actionKind = classifyPullRequestAction(payload?.action);
      if (actionKind === "ignore" || actionKind === "metadata") return;
    } else if (data.event === "check_run" || data.event === "check_suite") {
      if (payload?.action !== "rerequested") return;
    } else if (data.event === "merge_group") {
      if (payload?.action !== "checks_requested") return;
    }

    const installationId = payload?.installation?.id;
    if (!installationId) return;

    let ownerLogin: string | undefined;
    let repoName: string | undefined;
    let headSha: string | undefined;
    let checkRunId: number | undefined;

    if (data.event === "pull_request") {
      const ctx = assertPullRequestContext(payload);
      ownerLogin = ctx.ownerLogin;
      repoName = ctx.repoName;
      headSha = ctx.headSha;
    } else if (data.event === "merge_group") {
      headSha = payload?.merge_group?.head_sha;
      const repo = payload?.repository;
      ownerLogin =
        typeof repo?.owner?.login === "string" && repo.owner.login !== ""
          ? repo.owner.login
          : typeof repo?.full_name === "string"
            ? repo.full_name.split("/")[0]
            : undefined;
      repoName =
        typeof repo?.name === "string" && repo.name !== ""
          ? repo.name
          : typeof repo?.full_name === "string"
            ? repo.full_name.split("/")[1]
            : undefined;
    } else {
      const repository = payload.repository;
      repoName =
        typeof repository?.name === "string" && repository.name !== ""
          ? repository.name
          : typeof repository?.full_name === "string"
            ? repository.full_name.split("/")[1]
            : undefined;
      ownerLogin =
        typeof repository?.owner?.login === "string" && repository.owner.login !== ""
          ? repository.owner.login
          : typeof repository?.full_name === "string"
            ? repository.full_name.split("/")[0]
            : undefined;

      const attachedPr = (
        data.event === "check_run"
          ? payload.check_run?.pull_requests
          : payload.check_suite?.pull_requests
      )?.[0];
      headSha =
        attachedPr?.head?.sha ??
        (data.event === "check_run" ? payload.check_run?.head_sha : payload.check_suite?.head_sha);

      if (data.event === "check_run" && payload.check_run?.id) {
        checkRunId = Number(payload.check_run.id);
      }
    }

    if (!ownerLogin || !repoName || !headSha) return;

    const { appId, privateKey, Octokit: customOctokit } = getGitHubAppCredentials();
    const appClient = new App({
      appId,
      privateKey,
      ...(customOctokit ? { Octokit: customOctokit } : {}),
    });
    const octokit = await appClient.getInstallationOctokit(Number(installationId));

    await postScanErrorCheckRun(octokit as any, {
      owner: ownerLogin,
      repo: repoName,
      headSha,
      reason:
        "An internal error interrupted the scan. Re-run it by pushing a new commit or clicking Re-run.",
      checkRunId,
    });
  } catch (checkErr: any) {
    log.error("[QUEUE] Could not post fail-closed check run:", {
      error: checkErr?.message ?? String(checkErr),
    });
  }
}

export interface PublishScanSarifOptions {
  octokit: CodeScanningClient;
  repository: { full_name: string; name: string; owner: { login: string } };
  pullRequest: { number: number; head: { sha: string } };
  findings: readonly CodeScanningFinding[];
  dbRepo:
    | { id: string; codeScanningEnabled?: boolean | null; codeScanningWarning?: string | null }
    | null
    | undefined;
  log?: { info: (msg: string) => void; error?: (msg: string) => void };
}

/**
 * Opt-in per repository (#1865): Uploads findings to GitHub's native Code Scanning UI.
 * Deliberately after the check run and deliberately unable to fail the scan.
 * When the GitHub App lacks permissions (403/404), records a dashboard warning on the repository.
 */
export async function publishScanSarifAnalysis({
  octokit,
  repository,
  pullRequest,
  findings,
  dbRepo,
  log,
}: PublishScanSarifOptions): Promise<
  | { status: "uploaded" }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string }
> {
  const target = `${sanitize(repository.full_name)}#${sanitize(String(pullRequest.number))}`;
  if (!dbRepo?.codeScanningEnabled) {
    log?.info(`[Worker] Skipped SARIF upload for ${target}: code scanning publishing is disabled.`);
    return { status: "skipped", reason: "code-scanning-disabled" };
  }

  try {
    const sarifOutcome = await uploadSarifAnalysis(octokit, {
      owner: repository.owner.login,
      repo: repository.name,
      commitSha: pullRequest.head.sha,
      ref: pullRequestRef(pullRequest.number),
      document: buildSarifDocument(findings),
    });

    if (sarifOutcome.status === "uploaded") {
      log?.info(`[Worker] Uploaded SARIF for ${target}`);
      if (dbRepo.codeScanningWarning) {
        await prisma.repository.update({
          where: { id: dbRepo.id },
          data: { codeScanningWarning: null },
        });
      }
      return { status: "uploaded" };
    }

    log?.info(`[Worker] Skipped SARIF upload for ${target}: ${sanitize(sarifOutcome.reason)}`);
    if (sarifOutcome.reason === "code-scanning-unavailable") {
      const warningMsg =
        "GitHub App lacks security_events: write permission (Code scanning alerts: Read & Write) or Advanced Security is disabled on this repository.";
      await prisma.repository.update({
        where: { id: dbRepo.id },
        data: { codeScanningWarning: warningMsg },
      });
    }
    return { status: "skipped", reason: sarifOutcome.reason };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log?.info(
      `[Worker] SARIF upload errored for ${sanitize(repository.full_name)}: ${sanitize(errorMsg)}`,
    );
    return { status: "error", error: errorMsg };
  }
}

worker.on("completed", (job: Job) => {
  const correlationId =
    (job.data as WebhookJobData)?.correlationId ||
    (job.data as WebhookJobData)?.deliveryId ||
    job.id;
  logger.child({ correlationId, jobId: job.id }).info(`[QUEUE] Job ${job.id} completed.`);
});
worker.on("error", (err: Error) => {
  console.error("[QUEUE] Worker connection error:", err);
  logger.error("[QUEUE] Worker connection error:", { error: err.message });
});
worker.on("failed", async (job: Job | undefined, err: Error) => {
  if (!job) return;
  const correlationId =
    (job.data as WebhookJobData)?.correlationId ||
    (job.data as WebhookJobData)?.deliveryId ||
    job.id;
  const log = logger.child({ correlationId, jobId: job.id });
  const maxAttempts = job.opts.attempts || 3;
  if (job.attemptsMade >= maxAttempts) {
    log.error(
      `[DLQ] Job ${job.id} failed permanently after ${job.attemptsMade} attempts: ${err.message}`,
      { error: err.message, attemptsMade: job.attemptsMade },
    );
    try {
      await webhookDLQ.add(
        "process-webhook-dlq",
        {
          originalJobId: job.id,
          data: job.data,
          correlationId,
          failedReason: err.message,
          failedAt: new Date().toISOString(),
          attemptsMade: job.attemptsMade,
          ...dlqRetryStateFor(job.data?.dlqAutoRetryCount),
        },
        {
          attempts: 1,
        },
      );
    } catch (dlqErr: any) {
      log.error(`Failed to route job ${job.id} to DLQ:`, { error: dlqErr?.message });
    }

    // After DLQ routing, so a slow GitHub call can never delay the DLQ entry.
    await postScanFailureCheck(job.data, correlationId);
  } else {
    log.warn(
      `[QUEUE] Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}), retrying with exponential backoff: ${err.message}`,
      { attemptsMade: job.attemptsMade, maxAttempts, error: err.message },
    );
  }
});
