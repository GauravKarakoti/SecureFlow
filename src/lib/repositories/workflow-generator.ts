/**
 * SecureFlow GitHub Actions Workflow Generator (#2230)
 *
 * Generates clean, secure, and valid GitHub Actions workflow YAML based on
 * user configuration options (severity threshold, PR comments, AI remediation, etc.).
 */

export interface WorkflowOptions {
  /** Repository full name, e.g. "owner/repo" */
  repository?: string;
  /** Minimum severity to report (low, medium, high, critical) */
  severity?: "low" | "medium" | "high" | "critical";
  /** Severity threshold that fails the build (none, low, medium, high, critical) */
  failThreshold?: "none" | "low" | "medium" | "high" | "critical";
  /** Whether to post PR review comments */
  prComments?: boolean;
  /** Whether to enable automated AI remediation and patch suggestions */
  aiRemediation?: boolean;
  /** File or directory paths to scan */
  paths?: string;
  /** Default branch for triggers */
  workflowBranch?: string;
  /** Whether to upload SARIF report to GitHub Code Scanning */
  uploadSarif?: boolean;
}

export const WORKFLOW_FILE_PATH = ".github/workflows/secureflow.yml";

/**
 * Generate a complete, formatted GitHub Actions workflow file matching chosen options.
 */
export function generateWorkflowYaml(options: WorkflowOptions = {}): string {
  const {
    repository,
    severity = "low",
    failThreshold = "high",
    prComments = true,
    aiRemediation = false,
    paths = ".",
    workflowBranch = "main",
    uploadSarif = true,
  } = options;

  const headerComment = repository
    ? `# SecureFlow Security Scan Workflow for ${repository}\n`
    : "";

  const prCommentVal = prComments ? "true" : "false";

  const permissionsList = [
    "      contents: read",
    prComments ? "      pull-requests: write" : null,
    uploadSarif ? "      security-events: write" : null,
  ].filter(Boolean);

  const permissions = permissionsList.join("\n");

  const envLines: string[] = [];
  if (aiRemediation) {
    envLines.push("          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  }

  const envSection =
    envLines.length > 0 ? `\n        env:\n${envLines.join("\n")}` : "";

  const aiInput = aiRemediation ? `\n          ai-remediation: "true"` : "";

  const sarifStep = uploadSarif
    ? `\n      - name: Upload SARIF to GitHub Code Scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: \${{ steps.secureflow.outputs.sarif-file }}`
    : "";

  return `${headerComment}name: SecureFlow Security Scan

on:
  push:
    branches: [ ${workflowBranch} ]
  pull_request:
    branches: [ ${workflowBranch} ]

jobs:
  scan:
    name: Security Analysis
    runs-on: ubuntu-latest
    permissions:
${permissions}

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Run SecureFlow Security Scan
        id: secureflow
        uses: GauravKarakoti/SecureFlow@main
        with:
          paths: "${paths}"
          severity: "${severity}"
          fail-threshold: "${failThreshold}"
          comment-on-pr: "${prCommentVal}"
          format: "sarif"
          output: "results.sarif"
          github-token: \${{ secrets.GITHUB_TOKEN }}${aiInput}${envSection}
${sarifStep}
`.trim() + "\n";
}

