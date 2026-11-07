import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeDiff,
  computeScanCacheHash,
  scanCacheKey,
  getScanCacheTtlSeconds,
  getCachedScan,
  setCachedScan,
  invalidateScanCache,
  DEFAULT_SCAN_CACHE_TTL_SECONDS,
} from "./scan-cache";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

describe("scan-cache", () => {
  const sampleFiles: FileChange[] = [
    {
      filename: "src/auth.ts",
      patch: "@@ -1,3 +1,4 @@\n const a = 1;\n+const token = 'xyz';\n const b = 2;",
    },
  ];

  const samplePolicies = [
    {
      id: "policy-1",
      name: "No hardcoded secrets",
      description: "Detect hardcoded secrets",
      severity: "CRITICAL",
    },
  ];

  const sampleFindings: ScanFinding[] = [
    {
      type: "Secret",
      severity: "CRITICAL",
      description: "Hardcoded token found",
      fileLocation: "src/auth.ts",
      codeSnippet: "const token = 'xyz';",
      lineStart: 2,
      lineEnd: 2,
    },
  ];

  describe("normalizeDiff & computeScanCacheHash", () => {
    it("produces identical hashes for identical diffs regardless of file order", () => {
      const filesA: FileChange[] = [
        { filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n+const a = 1;" },
        { filename: "b.ts", patch: "@@ -1,1 +1,2 @@\n+const b = 2;" },
      ];
      const filesB: FileChange[] = [
        { filename: "b.ts", patch: "@@ -1,1 +1,2 @@\n+const b = 2;" },
        { filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n+const a = 1;" },
      ];

      const hashA = computeScanCacheHash({ files: filesA, activePolicies: samplePolicies });
      const hashB = computeScanCacheHash({ files: filesB, activePolicies: samplePolicies });
      expect(hashA).toBe(hashB);
    });

    it("produces a different hash when diff changes", () => {
      const filesA: FileChange[] = [{ filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n+const a = 1;" }];
      const filesB: FileChange[] = [{ filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n+const a = 2;" }];

      const hashA = computeScanCacheHash({ files: filesA, activePolicies: samplePolicies });
      const hashB = computeScanCacheHash({ files: filesB, activePolicies: samplePolicies });
      expect(hashA).not.toBe(hashB);
    });

    it("produces a different hash when active policies change", () => {
      const hash1 = computeScanCacheHash({
        files: sampleFiles,
        activePolicies: samplePolicies,
      });

      const hash2 = computeScanCacheHash({
        files: sampleFiles,
        activePolicies: [
          ...samplePolicies,
          { id: "policy-2", description: "Flag dangerous eval", severity: "HIGH" },
        ],
      });

      expect(hash1).not.toBe(hash2);
    });

    it("produces a different hash when policy version changes", () => {
      const hash1 = computeScanCacheHash({
        files: sampleFiles,
        activePolicies: samplePolicies,
        policyVersion: "1",
      });

      const hash2 = computeScanCacheHash({
        files: sampleFiles,
        activePolicies: samplePolicies,
        policyVersion: "2",
      });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("getScanCacheTtlSeconds", () => {
    it("returns default TTL when env var is unset", () => {
      expect(getScanCacheTtlSeconds({})).toBe(DEFAULT_SCAN_CACHE_TTL_SECONDS);
    });

    it("reads custom TTL from SCAN_CACHE_TTL_SECONDS", () => {
      expect(getScanCacheTtlSeconds({ SCAN_CACHE_TTL_SECONDS: "3600" })).toBe(3600);
    });

    it("falls back to default on invalid non-numeric TTL", () => {
      expect(getScanCacheTtlSeconds({ SCAN_CACHE_TTL_SECONDS: "invalid" })).toBe(
        DEFAULT_SCAN_CACHE_TTL_SECONDS,
      );
      expect(getScanCacheTtlSeconds({ SCAN_CACHE_TTL_SECONDS: "-10" })).toBe(
        DEFAULT_SCAN_CACHE_TTL_SECONDS,
      );
    });
  });

  describe("cache get, set, hit, miss and invalidation", () => {
    let mockRedis: any;
    let mockDb: any;
    let redisStorage: Map<string, string>;
    let dbStorage: Map<string, any>;

    beforeEach(() => {
      redisStorage = new Map();
      dbStorage = new Map();

      mockRedis = {
        get: vi.fn(async (key: string) => redisStorage.get(key) || null),
        set: vi.fn(async (key: string, val: string) => {
          redisStorage.set(key, val);
          return "OK";
        }),
        del: vi.fn(async (...keys: string[]) => {
          keys.forEach((k) => redisStorage.delete(k));
          return keys.length;
        }),
        keys: vi.fn(async (pattern: string) => Array.from(redisStorage.keys())),
      };

      mockDb = {
        scanCache: {
          findUnique: vi.fn(async ({ where }: any) => dbStorage.get(where.cacheKey) || null),
          upsert: vi.fn(async ({ where, create, update }: any) => {
            const existing = dbStorage.get(where.cacheKey);
            const val = existing ? { ...existing, ...update } : { ...create, id: "cache-1" };
            dbStorage.set(where.cacheKey, val);
            return val;
          }),
          delete: vi.fn(async ({ where }: any) => {
            dbStorage.delete(where.cacheKey);
            return true;
          }),
          deleteMany: vi.fn(async ({ where }: any = {}) => {
            if (where?.cacheKey) {
              dbStorage.delete(where.cacheKey);
            } else {
              dbStorage.clear();
            }
            return { count: 1 };
          }),
          update: vi.fn(async () => ({})),
        },
      };
    });

    it("returns null on cache miss", async () => {
      const key = scanCacheKey("non-existent-hash");
      const result = await getCachedScan(key, { redisClient: mockRedis, db: mockDb });
      expect(result).toBeNull();
      expect(mockRedis.get).toHaveBeenCalledWith(key);
      expect(mockDb.scanCache.findUnique).toHaveBeenCalledWith({
        where: { cacheKey: key },
        select: expect.any(Object),
      });
    });

    it("stores and retrieves scan findings on cache hit from Redis", async () => {
      const key = scanCacheKey("hash-123");
      await setCachedScan(key, sampleFindings, 3600, {
        redisClient: mockRedis,
        db: mockDb,
      });

      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockDb.scanCache.upsert).toHaveBeenCalled();

      const result = await getCachedScan(key, { redisClient: mockRedis, db: mockDb });
      expect(result).toEqual(sampleFindings);
      // Because Redis succeeded, DB wasn't needed for the read
      expect(mockDb.scanCache.findUnique).not.toHaveBeenCalled();
    });

    it("falls back to Prisma ScanCache when Redis is unavailable or misses", async () => {
      const key = scanCacheKey("hash-456");
      // Populate Prisma directly
      dbStorage.set(key, {
        id: "c-1",
        cacheKey: key,
        findingsJson: JSON.stringify(sampleFindings),
        expiresAt: new Date(Date.now() + 60000),
      });

      // Redis returns null
      const result = await getCachedScan(key, { redisClient: null as any, db: mockDb });
      expect(result).toEqual(sampleFindings);
      expect(mockDb.scanCache.findUnique).toHaveBeenCalledWith({
        where: { cacheKey: key },
        select: expect.any(Object),
      });
    });

    it("does not return expired cache entries from Prisma", async () => {
      const key = scanCacheKey("hash-expired");
      dbStorage.set(key, {
        id: "c-expired",
        cacheKey: key,
        findingsJson: JSON.stringify(sampleFindings),
        expiresAt: new Date(Date.now() - 5000), // expired 5 seconds ago
      });

      const result = await getCachedScan(key, { redisClient: null as any, db: mockDb });
      expect(result).toBeNull();
      expect(mockDb.scanCache.delete).toHaveBeenCalledWith({ where: { cacheKey: key } });
    });

    it("invalidates cache entries on demand", async () => {
      const key = scanCacheKey("hash-to-delete");
      await setCachedScan(key, sampleFindings, 3600, {
        redisClient: mockRedis,
        db: mockDb,
      });

      await invalidateScanCache(key, { redisClient: mockRedis, db: mockDb });
      const after = await getCachedScan(key, { redisClient: mockRedis, db: mockDb });
      expect(after).toBeNull();
    });
  });
});
