import { checkRunConclusion } from "./scan-persistence";

/** Branch protection matches on this exact name. Do not rename. */
export const SCAN_CHECK_NAME = "SecureFlow Scan";

type ChecksClient = {
  rest: { checks: { create: (params: any) => Promise<unknown> } };
};

interface ScanCheckParams {
  owner: string;
  repo: string;
  headSha: string;
  decision: unknown;
  findingsCount: number;
  fileCount: number;
  notice?: string;
}

export async function postScanCheckRun(octokit: ChecksClient, p: ScanCheckParams) {
  return octokit.rest.checks.create({
    owner: p.owner,
    repo: p.repo,
    name: SCAN_CHECK_NAME,
    head_sha: p.headSha,
    status: "completed",
    conclusion: checkRunConclusion(p.decision),
    output: {
      title: `Policy Decision: ${String(p.decision)}`,
      summary:
        `SecureFlow detected ${p.findingsCount} potential security issues across ${p.fileCount} analyzed file(s).` +
        (p.notice ? `\n\n${p.notice}` : ""),
    },
  });
}

/** Fail-closed: a scan that crashed must not look like a pass. */
export async function postScanErrorCheckRun(
  octokit: ChecksClient,
  p: { owner: string; repo: string; headSha: string; reason: string },
) {
  return octokit.rest.checks.create({
    owner: p.owner,
    repo: p.repo,
    name: SCAN_CHECK_NAME,
    head_sha: p.headSha,
    status: "completed",
    conclusion: "failure",
    output: {
      title: "Scan could not complete",
      summary: `SecureFlow could not finish scanning this PR, so it cannot be treated as safe to merge.\n\nReason: ${p.reason}`,
    },
  });
}
