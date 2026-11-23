"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { can } from "@/lib/auth/permissions";
import {
  buildFindingIssueTemplate,
  createGitHubIssue,
  type CreateIssueOptions,
} from "@/lib/github/issue-creator";
import { maskSecrets } from "@/lib/armor/secret-masking";

export interface FindingIssuePrefillResult {
  ok: boolean;
  error?: string;
  alreadyCreated?: boolean;
  issueUrl?: string | null;
  canCreate?: boolean;
  prefill?: {
    title: string;
    body: string;
    repositoryFullName: string;
  };
}

export interface CreateFindingIssueResult {
  ok: boolean;
  error?: string;
  issueUrl?: string;
  issueNumber?: number;
}

interface AuthUser {
  id: string;
  roles?: string[];
  role?: string;
}

async function requireSession(): Promise<AuthUser> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }
  return {
    id: session.user.id,
    roles: session.user.roles,
    role: (session.user as unknown as { role?: string }).role,
  };
}

async function getFindingScoped(findingId: string, userId: string, roles?: string[]) {
  const isAdmin = roles?.includes("ADMIN") ?? false;

  const finding = await prisma.finding.findFirst({
    where: {
      id: findingId,
      ...(isAdmin
        ? {}
        : {
            scanResult: {
              pullRequest: {
                repository: { userId },
              },
            },
          }),
    },
    include: {
      scanResult: {
        include: {
          pullRequest: {
            include: {
              repository: true,
            },
          },
        },
      },
    },
  });

  return finding;
}

/**
 * Returns prefilled issue title and body for a finding confirmation dialog.
 */
export async function getFindingIssuePrefill(
  findingId: string,
): Promise<FindingIssuePrefillResult> {
  try {
    const user = await requireSession();
    const finding = await getFindingScoped(findingId, user.id, user.roles);

    if (!finding) {
      return { ok: false, error: "Finding not found." };
    }

    const repo = finding.scanResult.pullRequest.repository;
    const canCreate = can(user, repo.id, "findings:create_issue");

    if (finding.issueUrl) {
      return {
        ok: true,
        alreadyCreated: true,
        issueUrl: finding.issueUrl,
        canCreate,
      };
    }

    const template = buildFindingIssueTemplate({
      id: finding.id,
      type: finding.type,
      severity: finding.severity,
      fileLocation: finding.fileLocation,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      codeSnippet: finding.codeSnippet,
      explanation: finding.explanation,
      remediation: finding.remediation,
      policyDecision: finding.scanResult.policyDecision,
      repositoryFullName: repo.fullName,
      pullRequestNumber: finding.scanResult.pullRequest.prNumber,
      commitSha: finding.scanResult.pullRequest.headSha,
    });

    return {
      ok: true,
      alreadyCreated: false,
      canCreate,
      prefill: {
        title: template.title,
        body: template.body,
        repositoryFullName: repo.fullName,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load finding prefill";
    return { ok: false, error: message };
  }
}

/**
 * Creates a GitHub issue from a security finding with secret redaction,
 * role verification (triagers and admins only), duplicate prevention, and audit logging.
 */
export async function createIssueForFinding(
  findingId: string,
  custom?: { title?: string; body?: string },
  options: CreateIssueOptions = {},
): Promise<CreateFindingIssueResult> {
  try {
    const user = await requireSession();
    const finding = await getFindingScoped(findingId, user.id, user.roles);

    if (!finding) {
      return { ok: false, error: "Finding not found." };
    }

    const repo = finding.scanResult.pullRequest.repository;

    // Role check: triagers and admins only
    if (!can(user, repo.id, "findings:create_issue")) {
      return {
        ok: false,
        error: "Permission denied: Only triagers and admins can create GitHub issues for findings.",
      };
    }

    // Duplicate check: a finding can have only one linked issue
    if (finding.issueUrl) {
      return {
        ok: false,
        error: `An issue has already been created for this finding: ${finding.issueUrl}`,
        issueUrl: finding.issueUrl,
      };
    }

    const [owner, repoName] = repo.fullName.split("/");
    if (!owner || !repoName) {
      return { ok: false, error: `Invalid repository full name: ${repo.fullName}` };
    }

    const template = buildFindingIssueTemplate({
      id: finding.id,
      type: finding.type,
      severity: finding.severity,
      fileLocation: finding.fileLocation,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      codeSnippet: finding.codeSnippet,
      explanation: finding.explanation,
      remediation: finding.remediation,
      policyDecision: finding.scanResult.policyDecision,
      repositoryFullName: repo.fullName,
      pullRequestNumber: finding.scanResult.pullRequest.prNumber,
      commitSha: finding.scanResult.pullRequest.headSha,
    });

    const finalTitle = maskSecrets(custom?.title?.trim() || template.title);
    const finalBody = maskSecrets(custom?.body?.trim() || template.body);

    const created = await createGitHubIssue(
      {
        owner,
        repo: repoName,
        title: finalTitle,
        body: finalBody,
      },
      options,
    );

    // Store issue URL on finding
    await prisma.finding.update({
      where: { id: finding.id },
      data: { issueUrl: created.url },
    });

    // Write audit log entry
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId: user.id,
        action: "FINDING_ISSUE_CREATED",
        resource: `${repo.fullName}:${finding.id}`,
        decision: "CREATED",
        metadata: {
          findingId: finding.id,
          repositoryId: repo.id,
          issueUrl: created.url,
          issueNumber: created.number,
          title: finalTitle,
        },
      }),
    });

    revalidatePath("/dashboard/findings");
    revalidatePath(`/dashboard/findings/${findingId}`);

    return {
      ok: true,
      issueUrl: created.url,
      issueNumber: created.number,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create issue";
    return { ok: false, error: message };
  }
}
