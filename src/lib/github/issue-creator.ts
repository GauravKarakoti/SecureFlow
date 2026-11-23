/**
 * GitHub App issue creation and finding template formatting.
 *
 * Implements Issue #1987:
 * - Pre-fills title and body with severity, policy, file and line link, explanation, and remediation advice.
 * - Redacts secrets and raw code snippets using existing masking (maskSecrets).
 * - Creates issues via GitHub App (requiring issues: write).
 * - Surfaces clear, actionable error messages when the permission is missing.
 */

import { maskSecrets } from "@/lib/armor/secret-masking";
import { createGitHubAppClient, getGitHubWebUrl } from "@/lib/github/app-auth";

export interface FindingIssueSourceData {
  id: string;
  type: string;
  severity: string;
  fileLocation: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  codeSnippet?: string | null;
  explanation?: string | null;
  remediation?: string | null;
  policyDecision?: string | null;
  repositoryFullName: string;
  pullRequestNumber?: number | null;
  commitSha?: string | null;
}

export interface FormattedIssueTemplate {
  title: string;
  body: string;
}

export class GitHubPermissionError extends Error {
  public statusCode: number = 403;
  constructor(message: string) {
    super(message);
    this.name = "GitHubPermissionError";
    Object.setPrototypeOf(this, GitHubPermissionError.prototype);
  }
}

/**
 * Builds the pre-filled title and body for a finding issue.
 * Secrets and raw code snippets are redacted using maskSecrets.
 * Raw code snippets are excluded from the body to prevent secret exposure in issues.
 */
export function buildFindingIssueTemplate(
  finding: FindingIssueSourceData,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): FormattedIssueTemplate {
  const lineRange =
    finding.lineStart && finding.lineEnd && finding.lineStart !== finding.lineEnd
      ? `L${finding.lineStart}-L${finding.lineEnd}`
      : finding.lineStart
        ? `L${finding.lineStart}`
        : null;

  const rawTitle = `[Security] ${finding.severity}: ${finding.type} in ${finding.fileLocation}${lineRange ? ` (${lineRange})` : ""}`;
  const title = maskSecrets(rawTitle);

  const webUrl = getGitHubWebUrl(env);
  const repoUrl = `${webUrl}/${finding.repositoryFullName}`;
  const ref = finding.commitSha || "main";
  const fileLink = lineRange
    ? `[${finding.fileLocation}#${lineRange}](${repoUrl}/blob/${ref}/${finding.fileLocation}#${lineRange})`
    : `[${finding.fileLocation}](${repoUrl}/blob/${ref}/${finding.fileLocation})`;

  const prLink = finding.pullRequestNumber
    ? `[#${finding.pullRequestNumber}](${repoUrl}/pull/${finding.pullRequestNumber})`
    : "N/A";

  const safeExplanation = finding.explanation
    ? maskSecrets(finding.explanation)
    : "No explanation provided.";

  const safeRemediation = finding.remediation
    ? maskSecrets(finding.remediation)
    : "Follow standard security practices to resolve this.";

  const bodyParts = [
    `## Security Finding Details`,
    ``,
    `- **Severity:** ${finding.severity}`,
    `- **Policy Decision:** ${finding.policyDecision || "N/A"}`,
    `- **Finding Type:** ${finding.type}`,
    `- **Location:** ${fileLink}`,
    `- **Pull Request:** ${prLink}`,
    ``,
    `### Explanation`,
    safeExplanation,
    ``,
    `### Remediation Guidance`,
    safeRemediation,
    ``,
    `---`,
    `*Created automatically by SecureFlow. Raw code snippets and sensitive secrets have been redacted.*`,
  ];

  return {
    title,
    body: maskSecrets(bodyParts.join("\n")),
  };
}

export interface OctokitIssuesClient {
  rest: {
    issues: {
      create: (params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
      }) => Promise<{ data: { html_url: string; number: number } }>;
    };
  };
}

export interface GitHubAppClientLike {
  octokit: {
    rest: {
      apps: {
        getRepoInstallation: (params: {
          owner: string;
          repo: string;
        }) => Promise<{ data: { id: number } }>;
      };
    };
  };
  getInstallationOctokit: (installationId: number) => Promise<OctokitIssuesClient>;
}

export interface CreateIssueOptions {
  appClient?: GitHubAppClientLike;
  octokitClient?: OctokitIssuesClient;
}

/**
 * Checks if an error corresponds to missing GitHub App permissions.
 */
export function isMissingIssuesPermissionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    status?: number;
    statusCode?: number;
    message?: string;
    response?: { status?: number };
  };
  const status = anyErr.status ?? anyErr.statusCode ?? anyErr.response?.status;
  const message = anyErr.message || "";

  if (status === 403) return true;
  if (/Resource not accessible by integration/i.test(message)) return true;
  if (/lacks.*permission/i.test(message)) return true;
  if (/issues:.*write/i.test(message)) return true;
  return false;
}

/**
 * Dispatches an issue creation request to GitHub using the GitHub App.
 */
export async function createGitHubIssue(
  params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
  },
  options: CreateIssueOptions = {},
): Promise<{ url: string; number: number }> {
  const { owner, repo, title, body } = params;
  const maskedTitle = maskSecrets(title);
  const maskedBody = maskSecrets(body);

  try {
    let client = options.octokitClient;

    if (!client) {
      const app =
        (options.appClient as unknown as ReturnType<typeof createGitHubAppClient>) ||
        createGitHubAppClient();
      let installationId: number;
      try {
        const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
          owner,
          repo,
        });
        installationId = installation.id;
      } catch (err: unknown) {
        if (isMissingIssuesPermissionError(err)) {
          throw new GitHubPermissionError(
            `The SecureFlow GitHub App lacks 'issues: write' permission on ${owner}/${repo}. Please grant 'Issues: Read and write' in the GitHub App settings.`,
          );
        }
        throw err;
      }

      client = (await app.getInstallationOctokit(installationId)) as unknown as OctokitIssuesClient;
    }

    const { data: issue } = await client.rest.issues.create({
      owner,
      repo,
      title: maskedTitle,
      body: maskedBody,
    });

    return {
      url: issue.html_url,
      number: issue.number,
    };
  } catch (err: unknown) {
    if (err instanceof GitHubPermissionError) {
      throw err;
    }
    if (isMissingIssuesPermissionError(err)) {
      throw new GitHubPermissionError(
        `The SecureFlow GitHub App lacks 'issues: write' permission on ${owner}/${repo}. Please grant 'Issues: Read and write' in the GitHub App settings.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create GitHub issue: ${message}`);
  }
}
