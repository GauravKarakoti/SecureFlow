import prisma from "@/lib/prisma";
import { App } from "octokit";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

export interface SyncUserReposResult {
  synced: number;
  hasInstallation: boolean;
  installationId?: number;
  error?: string;
}

/**
 * Syncs GitHub repositories for a given user across all 3 scenarios:
 * 1. Post-install webhook/setup flow
 * 2. New login without GitHub App installation (detects status)
 * 3. Pre-existing GitHub App installation discovered on manual login (#634)
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
      select: { githubLogin: true, accounts: true },
    });
    login = user?.githubLogin || null;
    if (!login && user?.accounts) {
      const githubAccount = user.accounts.find((a) => a.provider === "github");
      if (githubAccount?.providerAccountId) {
        // Provider account ID available
      }
    }
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

    const repoPromises = repositories.map((repo: any) =>
      prisma.repository.upsert({
        where: { githubId: BigInt(repo.id) },
        update: {
          isActive: true,
          userId: userId,
          fullName: repo.full_name,
          owner: repo.owner?.login || repo.full_name.split("/")[0],
        },
        create: {
          githubId: BigInt(repo.id),
          fullName: repo.full_name,
          owner: repo.owner?.login || repo.full_name.split("/")[0],
          userId: userId,
          isActive: true,
        },
      })
    );

    await Promise.all(repoPromises);

    try {
      await prisma.auditLog.create({
        data: sanitizeAuditLogInput({
          userId: userId,
          action: "REPOSITORY_SYNC",
          resource: repositories.map((r: any) => r.full_name).join(", "),
          metadata: {
            count: repositories.length,
            installationId,
            source: "github_app_sync",
          },
        }),
      });
    } catch {
      // Non-blocking audit log
    }

    return {
      synced: repositories.length,
      hasInstallation: true,
      installationId,
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
