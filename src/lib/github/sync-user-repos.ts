import prisma from "@/lib/prisma";
import { App } from "octokit";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import {
  REPO_SYNC_CONCURRENCY,
  auditRepositorySample,
  chunk,
  normalizeRepos,
  partitionByOwnership,
  syncAuditResource,
  type NormalizedRepo,
} from "./repo-ownership";

export interface SyncUserReposResult {
  synced: number;
  hasInstallation: boolean;
  installationId?: number;
  error?: string;
  /**
   * Repositories the installation exposes that already belong to another
   * SecureFlow user, and were therefore left alone (#657).
   *
   * Optional so existing callers that only read `synced` / `hasInstallation`
   * are unaffected.
   */
  skipped?: number;
  /** Their full names, bounded, so the UI can name a few of them. */
  skippedRepositories?: string[];
  /** Repositories whose write failed. The sync no longer aborts on the first one. */
  failed?: number;
}

/**
 * Syncs GitHub repositories for a given user across all 3 scenarios:
 * 1. Post-install webhook/setup flow
 * 2. New login without GitHub App installation (detects status)
 * 3. Pre-existing GitHub App installation discovered on manual login (#634)
 *
 * Ownership is claim-once (#657): a `Repository` row that already belongs to a
 * different user is reported and skipped rather than reassigned. See
 * `./repo-ownership` for why.
 */
export async function syncUserRepositories(
  userId: string,
  githubLogin?: string | null,
  accessToken?: string | null
): Promise<SyncUserReposResult> {
  if (!userId) {
    return { synced: 0, hasInstallation: false, error: "User ID is required" };
  }

  // Handle Mock DB environment
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    await prisma.repository.upsert({
      where: { githubId: BigInt(123456) },
      update: {
        isActive: true,
        userId: userId,
      },
      create: {
        githubId: BigInt(123456),
        fullName: "mock-owner/mock-repo",
        owner: "mock-owner",
        userId: userId,
        isActive: true,
      },
    });
    return { synced: 1, hasInstallation: true, installationId: 123456 };
  }

  // Retrieve user details from database if not supplied
  let login = githubLogin;
  if (!login) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { githubLogin: true },
    });
    login = user?.githubLogin || null;
  }

  const appId = process.env.GITHUB_APP_ID?.trim();
  const rawPrivateKey = process.env.GITHUB_PRIVATE_KEY;

  if (!appId || !rawPrivateKey) {
    console.warn("[RepoSync] GitHub App credentials not configured. Skipping sync.");
    return {
      synced: 0,
      hasInstallation: false,
      error: "GitHub App credentials not configured",
    };
  }

  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");
  const appClient = new App({ appId, privateKey });

  let installationId: number | null = null;

  // 1. Try finding installation by GitHub username
  if (login) {
    try {
      const userInstallation = await appClient.octokit.rest.apps.getUserInstallation({
        username: login,
      });
      if (userInstallation?.data?.id) {
        installationId = userInstallation.data.id;
      }
    } catch (err: any) {
      // 404 means user has not installed the GitHub App
      if (err?.status !== 404) {
        console.warn(`[RepoSync] Failed to check user installation for ${login}:`, err?.message);
      }
    }
  }

  // 2. If not found by username and OAuth access token is provided, check user installations
  if (!installationId && accessToken) {
    try {
      const { Octokit } = await import("octokit");
      const userOctokit = new Octokit({ auth: accessToken });
      const installationsRes = await userOctokit.rest.apps.listInstallationsForAuthenticatedUser({
        per_page: 10,
      });
      const targetAppId = Number(appId);
      const matched = installationsRes.data.installations.find(
        (inst: any) => inst.app_id === targetAppId
      );
      if (matched?.id) {
        installationId = matched.id;
      }
    } catch (err: any) {
      console.warn("[RepoSync] Failed to check installations via user token:", err?.message);
    }
  }

  // Scenario 2: No installation found
  if (!installationId) {
    return {
      synced: 0,
      hasInstallation: false,
    };
  }

  // Scenario 3: Installation found! Fetch accessible repositories and populate database
  try {
    const installationOctokit = await appClient.getInstallationOctokit(installationId);
    const repositories = await installationOctokit.paginate(
      installationOctokit.rest.apps.listReposAccessibleToInstallation,
      {
        per_page: 100,
      }
    );

    if (!repositories || repositories.length === 0) {
      return {
        synced: 0,
        hasInstallation: true,
        installationId,
      };
    }

    const { usable, malformed } = normalizeRepos(repositories as any[]);

    if (malformed > 0) {
      // Previously `BigInt(repo.id)` on a malformed entry threw inside a
      // Promise.all and took the whole batch with it.
      console.warn(`[RepoSync] Skipped ${malformed} repositories with an unusable id or name`);
    }

    if (usable.length === 0) {
      return { synced: 0, hasInstallation: true, installationId };
    }

    // Which of these already exist, and whose they are. This is the read that
    // makes the claim decision; the upsert below is written so that losing a
    // race against a concurrent sync still cannot move a row.
    const existing = await prisma.repository.findMany({
      where: { githubId: { in: usable.map((r) => r.githubId) } },
      select: { githubId: true, userId: true },
    });

    const { claimable, foreign } = partitionByOwnership(usable, existing, userId);

    if (foreign.length > 0) {
      console.warn(
        `[RepoSync] ${foreign.length} repositories are already tracked by another user and were not claimed`
      );
    }

    const written: NormalizedRepo[] = [];
    const failures: NormalizedRepo[] = [];

    // Bounded concurrency instead of one Promise.all over every repository, and
    // each write settled independently so one failure no longer aborts the rest
    // and leaves no record of how far it got.
    for (const batch of chunk(claimable, REPO_SYNC_CONCURRENCY)) {
      const settled = await Promise.allSettled(
        batch.map((repo) =>
          prisma.repository.upsert({
            where: { githubId: repo.githubId },
            update: {
              // `userId` is deliberately absent. Refreshing the name and the
              // active flag is legitimate — those track GitHub — but writing
              // the owner here is what handed an existing row to whoever
              // synced last (#657). Omitting it means even a row that changed
              // hands between the findMany above and this statement stays with
              // its current owner.
              isActive: true,
              fullName: repo.fullName,
              owner: repo.owner,
            },
            create: {
              githubId: repo.githubId,
              fullName: repo.fullName,
              owner: repo.owner,
              userId: userId,
              isActive: true,
            },
          })
        )
      );

      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          written.push(batch[index]);
        } else {
          failures.push(batch[index]);
          console.error(
            `[RepoSync] Failed to sync ${batch[index].fullName}:`,
            (outcome.reason as Error)?.message
          );
        }
      });
    }

    try {
      await prisma.auditLog.create({
        data: sanitizeAuditLogInput({
          userId: userId,
          action: "REPOSITORY_SYNC",
          // Bounded. This used to be every repository's full name joined with
          // commas into a single String column.
          resource: syncAuditResource(written.length, installationId),
          metadata: {
            count: written.length,
            skipped: foreign.length,
            failed: failures.length,
            malformed,
            installationId,
            source: "github_app_sync",
            repositories: auditRepositorySample(written),
          },
        }),
      });
    } catch {
      // Non-blocking audit log
    }

    return {
      synced: written.length,
      hasInstallation: true,
      installationId,
      skipped: foreign.length,
      skippedRepositories: auditRepositorySample(foreign),
      failed: failures.length,
    };
  } catch (err: any) {
    console.error("[RepoSync] Error populating repositories from installation:", err);
    return {
      synced: 0,
      hasInstallation: true,
      installationId,
      error: err?.message || "Failed to sync repositories",
    };
  }
}
