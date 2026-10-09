import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { App } from "octokit";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { getGitHubAppCredentials } from "@/lib/github/app-auth";
import {
  applyScopedUnifiedDiff,
  isAllowedAutoRemediationPath,
} from "@/lib/armor/auto-remediation";

async function readScopedSource(
  octokit: any,
  owner: string,
  repo: string,
  rootTreeSha: string,
  filePath: string,
): Promise<string | null> {
  const segments = filePath.split("/");
  let treeSha = rootTreeSha;

  for (const [index, segment] of segments.entries()) {
    const tree = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha });
    const entry = tree.data.tree.find((item: any) => item.path === segment);
    if (!entry) return null;

    if (index === segments.length - 1) {
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return null;
      const blob = await octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
      const encoding = blob.data.encoding === "base64" ? "base64" : "utf8";
      return Buffer.from(blob.data.content, encoding).toString("utf8");
    }

    if (entry.type !== "tree" || entry.mode !== "040000") return null;
    treeSha = entry.sha;
  }

  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { approved?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.approved !== true) {
    return NextResponse.json({ error: "Explicit approval is required" }, { status: 400 });
  }

  const { id } = await params;
  const finding = await prisma.finding.findFirst({
    where: {
      id,
      scanResult: { pullRequest: { repository: { userId: session.user.id } } },
    },
    select: {
      id: true,
      type: true,
      fileLocation: true,
      explanation: true,
      remediationPatch: { select: { patchDiff: true, status: true } },
      scanResult: {
        select: {
          pullRequest: {
            select: { repository: { select: { fullName: true } } },
          },
        },
      },
    },
  });

  if (!finding) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  if (!finding.remediationPatch?.patchDiff || finding.remediationPatch.status !== "GENERATED") {
    return NextResponse.json({ error: "No generated patch is awaiting approval" }, { status: 409 });
  }
  if (!isAllowedAutoRemediationPath(finding.fileLocation)) {
    return NextResponse.json({ error: "Finding is outside the allowed src/** scope" }, { status: 403 });
  }

  const [owner, repo, ...extra] = finding.scanResult.pullRequest.repository.fullName.split("/");
  if (!owner || !repo || extra.length > 0) {
    return NextResponse.json({ error: "Invalid repository configuration" }, { status: 400 });
  }

  try {
    const { appId, privateKey } = getGitHubAppCredentials();
    const app = new App({ appId, privateKey });
    const installation = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
    const octokit = await app.getInstallationOctokit(installation.data.id);
    const repository = await octokit.rest.repos.get({ owner, repo });
    const base = repository.data.default_branch;
    const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
    const baseCommit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseRef.data.object.sha,
    });
    const source = await readScopedSource(
      octokit,
      owner,
      repo,
      baseCommit.data.tree.sha,
      finding.fileLocation,
    );
    if (source === null) {
      return NextResponse.json({ error: "Source file is not available for remediation" }, { status: 409 });
    }

    const updatedContent = applyScopedUnifiedDiff(
      finding.remediationPatch.patchDiff,
      finding.fileLocation,
      source,
    );
    const blob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: updatedContent,
      encoding: "utf-8",
    });
    const tree = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree: [{ path: finding.fileLocation, mode: "100644", type: "blob", sha: blob.data.sha }],
    });
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: `fix: remediate ${finding.type.toLowerCase()} finding ${finding.id}`,
      tree: tree.data.sha,
      parents: [baseRef.data.object.sha],
    });

    const patchHash = createHash("sha256")
      .update(finding.remediationPatch.patchDiff)
      .digest("hex")
      .slice(0, 10);
    const branch = `secureflow/remediation-${finding.id.slice(-8)}-${patchHash}`;
    let commitSha = commit.data.sha;
    try {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commitSha });
    } catch (error) {
      if ((error as { status?: number }).status !== 422) throw error;
      const existingRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      commitSha = existingRef.data.object.sha;
    }

    const existingPullRequests = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`,
      base,
      per_page: 100,
    });
    const existingPullRequest = existingPullRequests.data[0];
    const pullRequest = existingPullRequest
      ? existingPullRequest
      : await octokit.rest.pulls.create({
          owner,
          repo,
          title: `Security fix: ${finding.type.toLowerCase()} in ${finding.fileLocation}`,
          head: branch,
          base,
          draft: true,
          body: [
            "## SecureFlow remediation",
            "",
            "This draft pull request contains an AI-generated security fix approved by a repository owner.",
            "",
            `Finding: ${finding.id}`,
            `File: \`${finding.fileLocation}\``,
            finding.explanation ? `\n${finding.explanation}` : "",
            "",
            "Please review and run the repository checks before merging.",
          ].join("\n"),
        }).then((result) => result.data);

    await prisma.remediationPatch.update({
      where: { findingId: finding.id },
      data: { status: "PR_CREATED" },
    });

    return NextResponse.json({
      success: true,
      branch,
      commit: commitSha,
      pullRequest: pullRequest.html_url,
    });
  } catch (error) {
    console.error("[AUTO_REMEDIATION] Failed to create approved pull request:", error);
    return NextResponse.json({ error: "Unable to create remediation pull request" }, { status: 502 });
  }
}