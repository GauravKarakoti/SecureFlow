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

describe("Repository Synchronization Engine (#634)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----";
    delete process.env.NEXT_PUBLIC_MOCK_DB;
  });

  it("returns error if userId is missing", async () => {
    const result = await syncUserRepositories("");
    expect(result.synced).toBe(0);
    expect(result.hasInstallation).toBe(false);
    expect(result.error).toContain("User ID is required");
  });

  it("handles mock DB environment cleanly", async () => {
    process.env.NEXT_PUBLIC_MOCK_DB = "true";
    vi.mocked(prisma.repository.upsert).mockResolvedValue({} as any);

    const result = await syncUserRepositories("user-mock");
    expect(result.synced).toBe(1);
    expect(result.hasInstallation).toBe(true);
    expect(prisma.repository.upsert).toHaveBeenCalled();
  });

  describe("Scenario 2: User logs in first without GitHub App installation", () => {
    it("detects when no GitHub App installation exists (404) and returns hasInstallation=false", async () => {
      const mockGetUserInstallation = vi.fn().mockRejectedValue({ status: 404 });
      const mockAppInstance = {
        octokit: {
          rest: {
            apps: {
              getUserInstallation: mockGetUserInstallation,
            },
          },
        },
      };

      vi.mocked(App).mockImplementation(function () { return mockAppInstance as any; } as any);
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
      const mockGetUserInstallation = vi.fn().mockResolvedValue({
        data: { id: 98765 },
      });

      const mockPaginate = vi.fn().mockResolvedValue([
        { id: 101, full_name: "alice_developer/repo-alpha", owner: { login: "alice_developer" } },
        { id: 102, full_name: "alice_developer/repo-beta", owner: { login: "alice_developer" } },
      ]);

      const mockInstallationOctokit = {
        paginate: mockPaginate,
        rest: {
          apps: {
            listReposAccessibleToInstallation: vi.fn(),
          },
        },
      };

      const mockAppInstance = {
        octokit: {
          rest: {
            apps: {
              getUserInstallation: mockGetUserInstallation,
            },
          },
        },
        getInstallationOctokit: vi.fn().mockResolvedValue(mockInstallationOctokit),
      };

      vi.mocked(App).mockImplementation(function () { return mockAppInstance as any; } as any);
      vi.mocked(prisma.repository.upsert).mockResolvedValue({} as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

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
      const mockGetUserInstallation = vi.fn().mockResolvedValue({
        data: { id: 98765 },
      });

      const mockAppInstance = {
        octokit: {
          rest: {
            apps: {
              getUserInstallation: mockGetUserInstallation,
            },
          },
        },
        getInstallationOctokit: vi.fn().mockRejectedValue(new Error("GitHub API secondary rate limit")),
      };

      vi.mocked(App).mockImplementation(function () { return mockAppInstance as any; } as any);

      const result = await syncUserRepositories("user-alice", "alice_developer");

      expect(result.synced).toBe(0);
      expect(result.hasInstallation).toBe(true);
      expect(result.error).toContain("GitHub API secondary rate limit");
    });
  });
});
