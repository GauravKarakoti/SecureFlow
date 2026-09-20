import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks "@/auth" for every suite; this one tests the real callbacks.
vi.unmock("@/auth");

const captured = vi.hoisted(() => ({ config: null as any }));

vi.mock("next-auth", () => ({
  default: vi.fn((config: unknown) => {
    captured.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  }),
}));
vi.mock("next-auth/providers/github", () => ({ default: vi.fn(() => ({ id: "github" })) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: vi.fn(() => ({})) }));

const mockFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ default: { user: { findUnique: mockFindUnique } } }));

import { ROLES_REFRESH_INTERVAL_MS } from "./auth";

const NOW = new Date("2026-09-19T12:00:00Z").getTime();

function dbUser(roles: string[], codename: string | null = "Tokyo") {
  return { id: "user-1", codename, roles: roles.map((name) => ({ role: { name } })) };
}

/** An established admin session: roles and codename present, no GitHub expiry to refresh. */
function adminToken(checkedAgoMs: number | undefined) {
  return {
    sub: "user-1",
    userId: "user-1",
    codename: "Tokyo",
    roles: ["ADMIN", "USER"],
    accessTokenExpires: 0,
    ...(checkedAgoMs === undefined ? {} : { rolesCheckedAt: NOW - checkedAgoMs }),
  };
}

const jwt = (token: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  captured.config.callbacks.jwt({ token, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockFindUnique.mockReset();
});

describe("auth jwt callback: role freshness", () => {
  it("drops ADMIN from a session once the database no longer grants it", async () => {
    mockFindUnique.mockResolvedValue(dbUser(["USER"]));

    const token = await jwt(adminToken(ROLES_REFRESH_INTERVAL_MS));

    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(token.roles).toEqual(["USER"]);
    expect(token.rolesCheckedAt).toBe(NOW);
  });

  it("re-reads roles for a token issued before roles were timestamped", async () => {
    mockFindUnique.mockResolvedValue(dbUser(["USER"]));

    const token = await jwt(adminToken(undefined));

    expect(token.roles).toEqual(["USER"]);
  });

  it("leaves a deleted user with no roles", async () => {
    mockFindUnique.mockResolvedValue(null);

    const token = await jwt(adminToken(ROLES_REFRESH_INTERVAL_MS + 1));

    expect(token.roles).toEqual([]);
  });

  it("trusts recently checked roles without a query", async () => {
    const token = await jwt(adminToken(ROLES_REFRESH_INTERVAL_MS - 1));

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(token.roles).toEqual(["ADMIN", "USER"]);
  });

  it("stamps the check on first sign-in", async () => {
    mockFindUnique.mockResolvedValue(dbUser(["USER"], null));

    const token = await jwt(
      { sub: "user-1" },
      {
        user: { id: "user-1", codename: null },
        account: { access_token: "gho_x", refresh_token: "ghr_x", expires_at: 0 },
      },
    );

    expect(token.roles).toEqual(["USER"]);
    expect(token.rolesCheckedAt).toBe(NOW);
  });

  it("promotes a user within the interval too", async () => {
    mockFindUnique.mockResolvedValue(dbUser(["ADMIN", "USER"]));
    const userToken = { ...adminToken(ROLES_REFRESH_INTERVAL_MS), roles: ["USER"] };

    expect((await jwt(userToken)).roles).toEqual(["ADMIN", "USER"]);
  });
});
