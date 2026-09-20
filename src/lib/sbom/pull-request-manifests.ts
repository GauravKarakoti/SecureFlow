import prisma from "@/lib/prisma";
import { Octokit } from "octokit";
import { enqueueSbomScan } from "@/lib/queue/sbomQueue";
import { fetchPullRequestFiles } from "@/lib/github/pull-request-files";

/**
 * Dependency (SBOM) scanning of the manifests a pull request push changes.
 *
 * This used to run inline in `/api/webhooks/github` before the delivery was
 * queued. #927 removed that call so a delivery has a single owner — the webhook
 * worker — but the worker never called it, which left PR manifest scanning with
 * no caller at all. It lives here so the worker can run it without importing a
 * Next.js route module.
 */

async function fetchFileContent(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  path: string,
  ref: string,
) {
  try {
    // Added .rest namespace
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if ("content" in data && data.content) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch (error) {
    console.error(`[SBOM] Failed to fetch ${path}:`, error);
    return null;
  }
}

/**
 * Executes routines when an existing Pull Request receives new code commits
 */
export async function handlePullRequestSynchronize(
  payload: Record<string, unknown> | any,
  deliveryId?: string,
) {
  const prNumber = payload.number;
  const repoName = payload.repository?.full_name;
  const headSha = payload.pull_request?.head?.sha;

  console.log(
    `[PR_SYNC] New code pushed to PR #${prNumber} on repo ${repoName}. Head SHA: ${headSha}`,
  );

  // Extract necessary fields for SBOM scanning
  const { pull_request, repository, installation } = payload;

  if (!pull_request || !repository || !installation) {
    console.warn("[PR_SYNC] Missing required fields for SBOM processing");
    return;
  }

  try {
    // 1. Resolve SecureFlow Repository
    const dbRepo = await prisma.repository.findUnique({
      where: { githubId: BigInt(repository.id) },
    });

    if (!dbRepo || !dbRepo.userId) {
      console.warn(
        `[PR_SYNC] Repository ${repository.full_name} (${repository.id}) not found or unowned in SecureFlow database. Skipping SBOM scan.`,
      );
      return;
    }

    // 2. Resolve or upsert PR Record using valid schema fields
    const dbPr = await prisma.pullRequest.upsert({
      where: { githubId: BigInt(pull_request.id) },
      update: {
        title: pull_request.title || `PR #${pull_request.number}`,
        state: pull_request.state === "closed" ? "CLOSED" : "OPEN",
      },
      create: {
        githubId: BigInt(pull_request.id),
        prNumber: pull_request.number,
        title: pull_request.title || `PR #${pull_request.number}`,
        state: pull_request.state === "closed" ? "CLOSED" : "OPEN",
        status: "REVIEW_REQUIRED",
        authorLogin: pull_request.user?.login || null,
        authorAvatarUrl: pull_request.user?.avatar_url || null,
        repositoryId: dbRepo.id,
      },
    });

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const owner = repository.owner.login;
    const repo = repository.name;

    // 3. Get changed files. Paginated: a bare `pulls.listFiles` call returns
    // only GitHub's first page of 30, so a manifest further down a larger pull
    // request was never scanned. The worker's PR scan already reads files
    // through this helper for the same reason.
    const { files, truncated, fetched, totalChanged } = await fetchPullRequestFiles(
      octokit as never,
      {
        owner,
        repo,
        pullNumber: pull_request.number,
        changedFiles:
          typeof pull_request.changed_files === "number" ? pull_request.changed_files : null,
      },
    );

    if (truncated) {
      console.warn(
        `[SBOM] PR #${pull_request.number} changed ${totalChanged ?? "more than " + fetched} files; checking manifests in the first ${fetched} only.`,
      );
    }

    // 4. SBOM Dependency Scan Integration
    console.log(`[SBOM] Checking ${files.length} files for manifests...`);

    for (const file of files) {
      // Detect manifest files
      if (file.filename.endsWith("package.json") || file.filename.endsWith("requirements.txt")) {
        console.log(`[SBOM] Detected manifest: ${file.filename}`);

        // Fetch the manifest at the PR's head commit. `head.ref` is a branch
        // name in the head repository: for a pull request from a fork that
        // branch does not exist on the base repository queried here (the fetch
        // 404s and the manifest is skipped), or it names an unrelated base
        // branch such as `main` and the wrong file is scanned. It is also a
        // moving target, while the dedupe key below is tied to `headSha`.
        // GitHub serves a pull request's head commit from the base repository.
        const content = await fetchFileContent(
          octokit,
          owner,
          repo,
          file.filename,
          headSha || pull_request.head.ref,
        );

        if (content) {
          // Derive deterministic deduplication key based on repo + PR + commit + filename
          const dedupeKey = `webhook:${dbRepo.id}:${dbPr.id}:${headSha || "head"}:${file.filename}`;
          const jobId = `sbom-${dbRepo.id}-${dbPr.id}-${headSha || "head"}-${file.filename.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

          // Offload SBOM dependency scan to background queue (#809)
          await enqueueSbomScan(
            {
              fileName: file.filename,
              content,
              userId: dbRepo.userId,
              repositoryId: dbRepo.id,
              pullRequestId: dbPr.id,
            },
            {
              jobId,
              dedupeKey,
              deliveryId,
            },
          );
          console.log(`[SBOM] Enqueued asynchronous SBOM scan for manifest: ${file.filename}`);
        }
      }
    }
  } catch (error) {
    console.error("[PR_SYNC] Error during SBOM processing:", error);
    // Don't throw - we still want to queue the job even if SBOM fails
  }
}
