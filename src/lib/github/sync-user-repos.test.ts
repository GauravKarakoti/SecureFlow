import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { syncUserRepositories } from "./sync-user-repos";
import { App } from "octokit";

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
    repository: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("octokit", () => {
  return {
    App: vi.fn(),
    Octokit: vi.fn(),
  };
});

/**
 * Install a mocked `App`.
 *
 * `mockImplementation(() => instance)` does not work here: `sync-user-repos`
 * calls `new App(...)`, and an arrow function is not a constructor. A `function`
 * expression is, and returning an object from it makes `new` yield that object.
 */
function mockApp(instance: unknown) {
  vi.mocked(App).mockImplementation(function () {
    return instance as any;
  } as any);
}

/** An `App` whose installation lookup resolves to `installationId`. */
function appWithInstallation(
  installationId: number,
  installationOctokit?: unknown
) {
  return {
    octokit: {
      rest: {
        apps: {
          getUserInstallation: vi.fn().mockResolvedValue({ data: { id: installationId } }),
        },
      },
    },
    getInstallationOctokit: vi.fn().mockResolvedValue(installationOctokit ?? {}),
  };
}

/** An installation client whose `paginate` returns `repos`. */
function octokitReturning(repos: unknown[]) {
  return {
    paginate: vi.fn().mockResolvedValue(repos),
    rest: {
      apps: {
        listReposAccessibleToInstallation: vi.fn(),
      },
    },
  };
}

function apiRepo(id: number, fullName: string) {
  return { id, full_name: fullName, owner: { login: fullName.split("/")[0] } };
}

/** The metadata written on the single REPOSITORY_SYNC audit row. */
function auditMetadata() {
  const create = prisma.auditLog.create as any;
  return create.mock.calls[0]?.[0]?.data?.metadata;
}

describe("Repository Synchronization Engine (#634)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----";
    delete process.env.NEXT_PUBLIC_MOCK_DB;

    vi.mocked(prisma.repository.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.repository.upsert).mockResolvedValue({} as any);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);
  });

  it("returns error if userId is missing", async () => {
    const result = await syncUserRepositories("");
    expect(result.synced).toBe(0);
    expect(result.hasInstallation).toBe(false);
    expect(result.error).toContain("User ID is required");
  });

  it("handles mock DB environment cleanly", async () => {
    process.env.NEXT_PUBLIC_MOCK_DB = "true";

    const result = await syncUserRepositories("user-mock");
    expect(result.synced).toBe(1);
    expect(result.hasInstallation).toBe(true);
    expect(prisma.repository.upsert).toHaveBeenCalled();
  });

  it("returns a clear error when the GitHub App credentials are not configured", async () => {
    delete process.env.GITHUB_APP_ID;

    const result = await syncUserRepositories("user-alice", "alice_developer");

    expect(result.hasInstallation).toBe(false);
    expect(result.error).toContain("GitHub App credentials not configured");
  });

  describe("Scenario 2: User logs in first without GitHub App installation", () => {
    it("detects when no GitHub App installation exists (404) and returns hasInstallation=false", async () => {
      const mockGetUserInstallation = vi.fn().mockRejectedValue({ status: 404 });

      mockApp({
        octokit: {
          rest: { apps: { getUserInstallation: mockGetUserInstallation } },
        },
      });
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        githubLogin: "alice_developer",
      } as any);

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.hasInstallation).toBe(false);
      expect(result.synced).toBe(0);
      expect(mockGetUserInstallation).toHaveBeenCalledWith({ username: "alice_developer" });
    });
  });

  describe("Scenario 3: Pre-existing GitHub App installation discovered on login", () => {
    it("discovers existing installation and populates repositories in database", async () => {
      mockApp(
        appWithInstallation(
          98765,
          octokitReturning([
            apiRepo(101, "alice_developer/repo-alpha"),
            apiRepo(102, "alice_developer/repo-beta"),
          ])
        )
      );

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.hasInstallation).toBe(true);
      expect(result.synced).toBe(2);
      expect(result.installationId).toBe(98765);

      expect(prisma.repository.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "REPOSITORY_SYNC",
            userId: "user-alice",
          }),
        })
      );
    });

    it("handles error during repository pagination and returns clean status", async () => {
      const mockAppInstance = {
        octokit: {
          rest: {
            apps: {
              getUserInstallation: vi.fn().mockResolvedValue({ data: { id: 98765 } }),
            },
          },
        },
        getInstallationOctokit: vi
          .fn()
          .mockRejectedValue(new Error("GitHub API secondary rate limit")),
      };

      mockApp(mockAppInstance);

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.synced).toBe(0);
      expect(result.hasInstallation).toBe(true);
      expect(result.error).toContain("GitHub API secondary rate limit");
    });

    it("returns early when the installation exposes no repositories", async () => {
      mockApp(appWithInstallation(98765, octokitReturning([])));

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result).toMatchObject({ synced: 0, hasInstallation: true, installationId: 98765 });
      expect(prisma.repository.upsert).not.toHaveBeenCalled();
    });
  });

  describe("Ownership (#657)", () => {
    it("never writes userId in the update branch, so an existing row keeps its owner", async () => {
      mockApp(
        appWithInstallation(98765, octokitReturning([apiRepo(101, "acme/api")]))
      );

      await syncUserRepositories("user-alice", "alice_developer");

      const call = vi.mocked(prisma.repository.upsert).mock.calls[0][0] as any;

      expect(call.update).not.toHaveProperty("userId");
      // The fields that legitimately track GitHub are still refreshed.
      expect(call.update).toMatchObject({
        isActive: true,
        fullName: "acme/api",
        owner: "acme",
      });
      expect(call.create).toMatchObject({ userId: "user-alice" });
    });

    it("skips a repository already owned by another user instead of taking it", async () => {
      vi.mocked(prisma.repository.findMany).mockResolvedValue([
        { githubId: BigInt(101), userId: "user-bob" },
      ] as any);

      mockApp(
        appWithInstallation(
          98765,
          octokitReturning([apiRepo(101, "acme/api"), apiRepo(102, "acme/web")])
        )
      );

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedRepositories).toEqual(["acme/api"]);

      // Only the unclaimed repository was written.
      expect(prisma.repository.upsert).toHaveBeenCalledTimes(1);
      const written = vi.mocked(prisma.repository.upsert).mock.calls[0][0] as any;
      expect(written.where.githubId).toBe(BigInt(102));
    });

    it("still refreshes a repository the caller already owns", async () => {
      vi.mocked(prisma.repository.findMany).mockResolvedValue([
        { githubId: BigInt(101), userId: "user-alice" },
      ] as any);

      mockApp(
        appWithInstallation(98765, octokitReturning([apiRepo(101, "acme/api-renamed")]))
      );

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.synced).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("only looks up the repositories the installation actually returned", async () => {
      mockApp(
        appWithInstallation(
          98765,
          octokitReturning([apiRepo(101, "acme/api"), apiRepo(102, "acme/web")])
        )
      );

      await syncUserRepositories("user-alice", "alice_developer");

      expect(prisma.repository.findMany).toHaveBeenCalledWith({
        where: { githubId: { in: [BigInt(101), BigInt(102)] } },
        select: { githubId: true, userId: true },
      });
    });
  });

  describe("Resilience and audit shape (#657)", () => {
    it("skips a malformed repository rather than aborting the whole batch", async () => {
      mockApp(
        appWithInstallation(
          98765,
          octokitReturning([
            apiRepo(101, "acme/api"),
            { id: "not-a-number", full_name: "acme/broken" },
            apiRepo(103, "acme/cli"),
          ])
        )
      );

      const result = await syncUserRepositories("user-alice", "alice_developer");

      // `BigInt("not-a-number")` used to throw inside a Promise.all and take
      // the two good repositories down with it.
      expect(result.synced).toBe(2);
      expect(auditMetadata()).toMatchObject({ malformed: 1 });
    });

    it("keeps going when one write fails and reports the count", async () => {
      vi.mocked(prisma.repository.upsert)
        .mockRejectedValueOnce(new Error("deadlock detected"))
        .mockResolvedValue({} as any);

      mockApp(
        appWithInstallation(
          98765,
          octokitReturning([apiRepo(101, "acme/api"), apiRepo(102, "acme/web")])
        )
      );

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.synced).toBe(1);
      expect(result.failed).toBe(1);
    });

    it("writes a short audit resource instead of every repository name", async () => {
      const many = Array.from({ length: 120 }, (_, i) => apiRepo(i + 1, `acme/repo-${i}`));
      mockApp(appWithInstallation(98765, octokitReturning(many)));

      await syncUserRepositories("user-alice", "alice_developer");

      const resource = (prisma.auditLog.create as any).mock.calls[0][0].data.resource;

      expect(resource).toBe("installation:98765:120");
      expect(resource.length).toBeLessThan(60);
    });

    it("bounds the repository names carried in the audit metadata", async () => {
      const many = Array.from({ length: 120 }, (_, i) => apiRepo(i + 1, `acme/repo-${i}`));
      mockApp(appWithInstallation(98765, octokitReturning(many)));

      await syncUserRepositories("user-alice", "alice_developer");

      expect(auditMetadata().count).toBe(120);
      expect(auditMetadata().repositories.length).toBeLessThanOrEqual(25);
    });

    it("does not fail the sync when the audit write throws", async () => {
      vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error("audit down"));
      mockApp(appWithInstallation(98765, octokitReturning([apiRepo(101, "acme/api")])));

      await expect(
        syncUserRepositories("user-alice", "alice_developer")
      ).resolves.toMatchObject({ synced: 1 });
    });
  });
});
