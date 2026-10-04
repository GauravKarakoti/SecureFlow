import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();

vi.mock("@/lib/redis", () => ({
  redis: {
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  },
}));

const mockFindManyTemplates = vi.hoisted(() => vi.fn());
const mockFindManyToggles = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    policyTemplate: { findMany: mockFindManyTemplates },
    userPolicyToggle: { findMany: mockFindManyToggles },
  },
}));

import {
  getActivePoliciesForUser,
  fetchPoliciesFromDb,
  invalidatePolicyCache,
  policyCacheKey,
  POLICY_CACHE_TTL_SECONDS,
} from "./policy-cache";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMPLATES = [
  { id: "tpl-1", name: "Block Secrets", description: "...", severity: "CRITICAL", action: "DENY", rules: {}, isDefault: true },
  { id: "tpl-2", name: "SQL Injection", description: "...", severity: "HIGH", action: "REVIEW REQUIRED", rules: {}, isDefault: false },
];

const TOGGLES_ENABLE_BOTH = [
  { policyTemplateId: "tpl-1", isActive: true },
  { policyTemplateId: "tpl-2", isActive: true },
];

const CACHED_POLICIES = JSON.stringify([
  { id: "tpl-1", name: "Block Secrets", isActive: true },
]);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindManyTemplates.mockResolvedValue(TEMPLATES);
  mockFindManyToggles.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// policyCacheKey
// ---------------------------------------------------------------------------

describe("policyCacheKey", () => {
  it("returns a namespaced key for the userId", () => {
    expect(policyCacheKey("user-1")).toBe("policy:active:user-1");
  });
});

// ---------------------------------------------------------------------------
// getActivePoliciesForUser — cache hit
// ---------------------------------------------------------------------------

describe("getActivePoliciesForUser — cache hit", () => {
  it("returns cached data without hitting Prisma", async () => {
    mockRedisGet.mockResolvedValue(CACHED_POLICIES);

    const result = await getActivePoliciesForUser("user-1");

    expect(result).toEqual(JSON.parse(CACHED_POLICIES));
    expect(mockFindManyTemplates).not.toHaveBeenCalled();
    expect(mockFindManyToggles).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getActivePoliciesForUser — cache miss
// ---------------------------------------------------------------------------

describe("getActivePoliciesForUser — cache miss", () => {
  it("fetches from Prisma and writes to Redis on a miss", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockFindManyToggles.mockResolvedValue(TOGGLES_ENABLE_BOTH);

    await getActivePoliciesForUser("user-1");

    expect(mockFindManyTemplates).toHaveBeenCalledOnce();
    expect(mockFindManyToggles).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockRedisSet).toHaveBeenCalledWith(
      policyCacheKey("user-1"),
      expect.any(String),
      "EX",
      POLICY_CACHE_TTL_SECONDS,
    );
  });

  it("returns only policies the user has enabled", async () => {
    mockRedisGet.mockResolvedValue(null);
    // Only tpl-2 toggled on; tpl-1 is isDefault:true so it's on by default
    mockFindManyToggles.mockResolvedValue([
      { policyTemplateId: "tpl-2", isActive: true },
      { policyTemplateId: "tpl-1", isActive: false },
    ]);

    const result = await getActivePoliciesForUser("user-1");

    // tpl-1 explicitly disabled, tpl-2 explicitly enabled
    expect(result.map((p) => p.id)).toEqual(["tpl-2"]);
  });

  it("includes isDefault:true policies when user has no toggle for them", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockFindManyToggles.mockResolvedValue([]); // no toggles at all

    const result = await getActivePoliciesForUser("user-1");

    // tpl-1 isDefault:true → included; tpl-2 isDefault:false → excluded
    expect(result.map((p) => p.id)).toEqual(["tpl-1"]);
  });
});

// ---------------------------------------------------------------------------
// getActivePoliciesForUser — Redis fallback
// ---------------------------------------------------------------------------

describe("getActivePoliciesForUser — Redis error fallback", () => {
  it("falls back to Prisma when Redis.get throws", async () => {
    mockRedisGet.mockRejectedValue(new Error("ECONNRESET"));
    mockFindManyToggles.mockResolvedValue([]);

    const result = await getActivePoliciesForUser("user-1");

    expect(result).toHaveLength(1); // tpl-1 isDefault
    expect(mockFindManyTemplates).toHaveBeenCalledOnce();
  });

  it("does not throw when Redis.set fails after a miss", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockRejectedValue(new Error("Redis write failed"));

    await expect(getActivePoliciesForUser("user-1")).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// invalidatePolicyCache
// ---------------------------------------------------------------------------

describe("invalidatePolicyCache", () => {
  it("deletes the correct Redis key", async () => {
    await invalidatePolicyCache("user-1");

    expect(mockRedisDel).toHaveBeenCalledWith(policyCacheKey("user-1"));
  });

  it("does not throw when Redis.del fails", async () => {
    mockRedisDel.mockRejectedValue(new Error("Redis down"));

    await expect(invalidatePolicyCache("user-1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchPoliciesFromDb
// ---------------------------------------------------------------------------

describe("fetchPoliciesFromDb", () => {
  it("runs both Prisma queries in parallel", async () => {
    mockFindManyToggles.mockResolvedValue([]);

    await fetchPoliciesFromDb("user-1");

    expect(mockFindManyTemplates).toHaveBeenCalledOnce();
    expect(mockFindManyToggles).toHaveBeenCalledOnce();
  });

  it("sets isActive:true on every returned policy", async () => {
    mockFindManyToggles.mockResolvedValue(TOGGLES_ENABLE_BOTH);

    const result = await fetchPoliciesFromDb("user-1");

    expect(result.every((p) => p.isActive === true)).toBe(true);
  });
});
