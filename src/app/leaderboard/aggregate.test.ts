import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  default: {
    pullRequest: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
}));

import { loadLeaderboard, loadContributors } from "./aggregate";

describe("Leaderboard Codename Sync (#420)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the user's custom codename from database when matched by githubLogin", async () => {
    vi.mocked(prisma.pullRequest.groupBy)
      .mockResolvedValueOnce([
        { authorLogin: "gauravkarakoti", _count: { _all: 5 } },
      ] as any)
      .mockResolvedValueOnce([
        { authorLogin: "gauravkarakoti", _count: { _all: 3 } },
      ] as any);

    vi.mocked(prisma.pullRequest.findMany).mockResolvedValueOnce([
      { authorLogin: "gauravkarakoti", authorAvatarUrl: "https://avatar.com/gaurav.png" },
    ] as any);

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        githubLogin: "GauravKarakoti",
        name: "Gaurav Karakoti",
        email: "gaurav@example.com",
        codename: "Delhi",
      },
    ] as any);

    const contributors = await loadContributors();

    expect(contributors).toHaveLength(1);
    expect(contributors[0].login).toBe("gauravkarakoti");
    expect(contributors[0].codename).toBe("Delhi");
  });

  it("uses the user's codename from database when matched by name or email prefix", async () => {
    vi.mocked(prisma.pullRequest.groupBy)
      .mockResolvedValueOnce([
        { authorLogin: "delhi_user", _count: { _all: 4 } },
      ] as any)
      .mockResolvedValueOnce([
        { authorLogin: "delhi_user", _count: { _all: 2 } },
      ] as any);

    vi.mocked(prisma.pullRequest.findMany).mockResolvedValueOnce([
      { authorLogin: "delhi_user", authorAvatarUrl: "https://avatar.com/delhi.png" },
    ] as any);

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        githubLogin: null,
        name: "Delhi_User",
        email: "delhi_user@example.com",
        codename: "Delhi",
      },
    ] as any);

    const contributors = await loadContributors();

    expect(contributors).toHaveLength(1);
    expect(contributors[0].codename).toBe("Delhi");
  });

  it("generates a deterministic fallback city codename if user is not in database", async () => {
    vi.mocked(prisma.pullRequest.groupBy)
      .mockResolvedValueOnce([
        { authorLogin: "unknown_contributor", _count: { _all: 2 } },
      ] as any)
      .mockResolvedValueOnce([
        { authorLogin: "unknown_contributor", _count: { _all: 1 } },
      ] as any);

    vi.mocked(prisma.pullRequest.findMany).mockResolvedValueOnce([] as any);

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as any);

    const contributors = await loadContributors();

    expect(contributors).toHaveLength(1);
    expect(contributors[0].codename).toBeDefined();
    expect(typeof contributors[0].codename).toBe("string");
    expect(contributors[0].codename).not.toBe("Delhi");
  });
});
