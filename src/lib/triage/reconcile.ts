import { App } from "octokit";
import prisma from "@/lib/prisma";
import { getGitHubAppCredentials } from "@/lib/github/app-auth";
import { SCAN_CHECK_NAME } from "@/lib/scanner/check-run";
import { checkRunConclusion } from "@/lib/scanner/scan-persistence";
import { DEFAULT_GATE_CONFIG, type GateConfig } from "@/lib/scanner/gate-config";
import { normalizePolicyDecisionEnum, normalizePrStatusEnum } from "@/lib/finding-taxonomy";
import { activeSuppressionWhere } from "./expiry";
import { triagedVerdict, type StoredTriageFinding } from "./verdict";

export interface TriageReconcileResult {
  updated: number;
  pending: number;
}

interface TriagePullRequest {
  id: string;
  prNumber: number;
  repository: { fullName: string };
  scans: {
    id: string;
    headSha: string | null;
    gateConfig: unknown;
    findings: StoredTriageFinding[];
  }[];
}

function savedGateConfig(value: unknown): GateConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const gate = value as Partial<GateConfig>;
    if (typeof gate.blockOn === "string" && typeof gate.reviewOn === "string") {
      return gate as GateConfig;
    }
  }
  return DEFAULT_GATE_CONFIG;
}

/**
 * Refresh only PRs whose latest saved scan contains a changed fingerprint.
 * Older scans have no head SHA. They must be rescanned before a passing check
 * can be issued; a triage action must never certify an unscanned commit.
 */
export async function reconcileTriageVerdicts(
  repositoryId: string,
  changedFingerprints: readonly string[],
): Promise<TriageReconcileResult> {
  if (changedFingerprints.length === 0) return { updated: 0, pending: 0 };

  const pullRequests = (await prisma.pullRequest.findMany({
    where: {
      repositoryId,
      state: "OPEN",
      scans: { some: { findings: { some: { fingerprint: { in: [...changedFingerprints] } } } } },
    },
    select: {
      id: true,
      prNumber: true,
      repository: { select: { fullName: true } },
      scans: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          headSha: true,
          gateConfig: true,
          findings: {
            select: {
              fingerprint: true,
              type: true,
              severity: true,
              fileLocation: true,
              codeSnippet: true,
              explanation: true,
              lineStart: true,
              lineEnd: true,
            },
          },
        },
      },
    },
  })) as TriagePullRequest[];

  const affected = pullRequests.filter((pr) =>
    pr.scans[0]?.findings.some((finding) => changedFingerprints.includes(finding.fingerprint)),
  );
  if (affected.length === 0) return { updated: 0, pending: 0 };

  const triages = (await prisma.findingTriage.findMany({
    where: { repositoryId, ...activeSuppressionWhere(new Date()) },
    select: { fingerprint: true },
  })) as { fingerprint: string }[];
  const suppressed = new Set<string>(triages.map((triage) => triage.fingerprint));

  let updated = 0;
  let pending = 0;
  const { appId, privateKey, Octokit: customOctokit } = getGitHubAppCredentials();
  const app = new App({
    appId,
    privateKey,
    ...(customOctokit ? { Octokit: customOctokit } : {}),
  });
  const [owner, repo] = affected[0].repository.fullName.split("/");
  if (!owner || !repo) return { updated: 0, pending: affected.length };

  const installation = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
  const octokit = await app.getInstallationOctokit(installation.data.id);

  for (const pr of affected) {
    const scan = pr.scans[0];
    if (!scan?.headSha) {
      pending++;
      continue;
    }

    try {
      const remote = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.prNumber });
      if (remote.data.state !== "open" || remote.data.head.sha !== scan.headSha) {
        pending++;
        continue;
      }

      const checks = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: scan.headSha,
        check_name: SCAN_CHECK_NAME,
      });
      const check = checks.data.check_runs.find(
        (run) => run.name === SCAN_CHECK_NAME && run.output?.title?.startsWith("Policy Decision:"),
      );
      if (!check) {
        pending++;
        continue;
      }

      const { decision, riskScore, active } = triagedVerdict(
        scan.findings,
        suppressed,
        savedGateConfig(scan.gateConfig),
      );

      // Keep GitHub's merge gate in sync before changing the dashboard verdict.
      // In particular, reopening a finding must not leave an old passing check.
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: check.id,
        status: "completed",
        conclusion: checkRunConclusion(decision),
        output: {
          title: `Policy Decision: ${decision}`,
          summary: `SecureFlow has ${active.length} active finding(s) after repository-owner triage. The scanned commit is ${scan.headSha}.`,
        },
      });

      await prisma.$transaction([
        prisma.scanResult.update({
          where: { id: scan.id },
          data: { policyDecision: normalizePolicyDecisionEnum(decision), riskScore },
        }),
        prisma.pullRequest.update({
          where: { id: pr.id },
          data: { status: normalizePrStatusEnum(decision) },
        }),
      ]);
      updated++;
    } catch {
      // The triage decision is persisted. A retry or next scan will refresh the
      // check; never claim the current PR verdict changed when it did not.
      pending++;
    }
  }

  return { updated, pending };
}
