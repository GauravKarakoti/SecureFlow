import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  computeContentHash,
  resolveCacheDir,
  getCacheEntry,
  setCacheEntry,
  clearCache,
  pruneCache,
  getCacheStats,
  parseDurationMs,
  parseSizeBytes,
  reapOrphanedTempFiles,
  enforceCacheStorageLimit,
  scanFileWithCache,
  scanFilesWithCache,
  getRulesetVersion,
  setRulesetVersion,
  resetRulesetVersion,
  DEFAULT_RULESET_VERSION,
  type CacheEntry,
} from "./cache.js";

describe("Cache Module - Content Hash and Ruleset Version Caching", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-test-"));
    resetRulesetVersion();
  });

  afterEach(() => {
    resetRulesetVersion();
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  describe("1. computeContentHash", () => {
    it("computes deterministic SHA-256 hex digest for string content", () => {
      const content = "const secretKey = 'test';";
      const hash1 = computeContentHash(content);
      const hash2 = computeContentHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
    });

    it("produces distinct hashes for different contents", () => {
      const hash1 = computeContentHash("const x = 1;");
      const hash2 = computeContentHash("const x = 2;");
      expect(hash1).not.toBe(hash2);
    });

    it("supports Buffer input identically to string", () => {
      const str = "function test() { return 42; }";
      const hashFromStr = computeContentHash(str);
      const hashFromBuf = computeContentHash(Buffer.from(str, "utf-8"));
      expect(hashFromBuf).toBe(hashFromStr);
    });
  });

  describe("2. resolveCacheDir", () => {
    it("respects explicit customDir", () => {
      const custom = path.join(tempDir, "custom-cache");
      expect(resolveCacheDir(custom)).toBe(path.resolve(custom));
    });

    it("respects SECUREFLOW_CACHE_DIR environment variable", () => {
      const envCache = path.join(tempDir, "env-cache");
      process.env.SECUREFLOW_CACHE_DIR = envCache;
      try {
        expect(resolveCacheDir()).toBe(path.resolve(envCache));
      } finally {
        delete process.env.SECUREFLOW_CACHE_DIR;
      }
    });

    it("defaults to <repoRoot>/.secureflow/cache", () => {
      const dir = resolveCacheDir(undefined, tempDir);
      expect(dir).toContain(".secureflow");
      expect(dir).toContain("cache");
    });
  });

  describe("3. getCacheEntry & setCacheEntry", () => {
    it("returns null on cache miss (non-existent entry)", () => {
      const result = getCacheEntry({
        content: "const a = 1;",
        cacheDir: tempDir,
      });
      expect(result).toBeNull();
    });

    it("stores and retrieves a scan result by content hash", () => {
      const content = "const token = 'xyz';";
      const mockResult = {
        path: "src/auth.ts",
        violations: [{ line: 1, text: "const token = 'xyz';", reason: "hardcoded token" }],
      };

      setCacheEntry({
        filePath: "src/auth.ts",
        content,
        result: mockResult,
        cacheDir: tempDir,
      });

      const entry = getCacheEntry({
        content,
        cacheDir: tempDir,
      });

      expect(entry).not.toBeNull();
      expect(entry?.rulesetVersion).toBe(DEFAULT_RULESET_VERSION);
      expect(entry?.result.violations).toHaveLength(1);
      expect(entry?.result.violations[0]?.line).toBe(1);
    });

    it("stores and preserves AI findings in the cache entry", () => {
      const content = "export function api() {}";
      const mockResult = { path: "api.ts", violations: [] };
      const aiFindings = [
        {
          severity: "HIGH" as const,
          type: "insecure-transport",
          fileLocation: "api.ts",
          lineStart: 1,
          description: "Missing TLS enforcement",
          codeSnippet: "http://example.com",
        },
      ];

      setCacheEntry({
        filePath: "api.ts",
        content,
        result: mockResult,
        aiFindings,
        cacheDir: tempDir,
      });

      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).not.toBeNull();
      expect(entry?.aiFindings).toHaveLength(1);
      expect(entry?.aiFindings?.[0]?.severity).toBe("HIGH");
    });

    it("invalidates cache entry when ruleset version changes", () => {
      const content = "const query = 'SELECT 1';";
      const mockResult = { path: "db.ts", violations: [] };

      // Cache under version 1.0.0
      setRulesetVersion("1.0.0");
      setCacheEntry({
        filePath: "db.ts",
        content,
        result: mockResult,
        cacheDir: tempDir,
      });

      // Entry exists under ruleset version 1.0.0
      expect(getCacheEntry({ content, cacheDir: tempDir })).not.toBeNull();

      // Invalidate by bumping ruleset version to 2.0.0
      setRulesetVersion("2.0.0");
      expect(getRulesetVersion()).toBe("2.0.0");
      expect(getCacheEntry({ content, cacheDir: tempDir })).toBeNull();

      // Restore ruleset version 1.0.0: entry is valid again
      setRulesetVersion("1.0.0");
      expect(getCacheEntry({ content, cacheDir: tempDir })).not.toBeNull();
    });

    it("invalidates cache entry when file content changes", () => {
      const mockResult = { path: "file.ts", violations: [] };

      setCacheEntry({
        filePath: "file.ts",
        content: "version 1",
        result: mockResult,
        cacheDir: tempDir,
      });

      expect(getCacheEntry({ content: "version 1", cacheDir: tempDir })).not.toBeNull();
      expect(getCacheEntry({ content: "version 2", cacheDir: tempDir })).toBeNull();
    });
  });

  describe("4. Corrupt and Malformed Cache File Handling", () => {
    it("handles empty cache files gracefully by removing them and returning null", () => {
      const content = "const empty = true;";
      const hash = computeContentHash(content);
      const cacheFile = path.join(tempDir, `${hash}.json`);
      fs.writeFileSync(cacheFile, "", "utf-8");

      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).toBeNull();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("handles invalid JSON syntax by removing corrupt file and returning null", () => {
      const content = "const corrupt = true;";
      const hash = computeContentHash(content);
      const cacheFile = path.join(tempDir, `${hash}.json`);
      fs.writeFileSync(cacheFile, "{ invalid json ...", "utf-8");

      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).toBeNull();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("handles truncated JSON objects without crashing", () => {
      const content = "const truncated = 123;";
      const hash = computeContentHash(content);
      const cacheFile = path.join(tempDir, `${hash}.json`);
      fs.writeFileSync(cacheFile, '{"rulesetVersion": "1.0.0", "result":', "utf-8");

      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).toBeNull();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("handles cache file with missing violations array", () => {
      const content = "const malformed = 456;";
      const hash = computeContentHash(content);
      const cacheFile = path.join(tempDir, `${hash}.json`);
      const invalidEntry = {
        rulesetVersion: DEFAULT_RULESET_VERSION,
        contentHash: hash,
        result: { path: "test.ts" }, // missing violations array
      };
      fs.writeFileSync(cacheFile, JSON.stringify(invalidEntry), "utf-8");

      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).toBeNull();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("handles cache file with mismatched internal contentHash", () => {
      const content = "const contentMismatch = 789;";
      const hash = computeContentHash(content);
      const cacheFile = path.join(tempDir, `${hash}.json`);
      const mismatchedEntry: CacheEntry = {
        version: 1,
        rulesetVersion: DEFAULT_RULESET_VERSION,
        contentHash: "different-hash-than-filename",
        filePath: "test.ts",
        result: { path: "test.ts", violations: [] },
        cachedAt: Date.now(),
      };
      fs.writeFileSync(cacheFile, JSON.stringify(mismatchedEntry), "utf-8");

      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).toBeNull();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });
  });

  describe("5. clearCache", () => {
    it("returns cleared: true and count: 0 for non-existent directory", () => {
      const missingDir = path.join(tempDir, "does-not-exist");
      const res = clearCache(missingDir);
      expect(res.cleared).toBe(true);
      expect(res.count).toBe(0);
    });

    it("clears all .json and .tmp cache files in the directory", () => {
      fs.writeFileSync(path.join(tempDir, "entry1.json"), "{}", "utf-8");
      fs.writeFileSync(path.join(tempDir, "entry2.json"), "{}", "utf-8");
      fs.writeFileSync(path.join(tempDir, ".entry3.tmp"), "{}", "utf-8");
      fs.writeFileSync(path.join(tempDir, "keep.txt"), "important", "utf-8");

      const res = clearCache(tempDir);
      expect(res.cleared).toBe(true);
      expect(res.count).toBe(3);
      expect(fs.existsSync(path.join(tempDir, "keep.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "entry1.json"))).toBe(false);
    });
  });

  describe("6. scanFileWithCache", () => {
    it("analyzes file and caches on first scan (cache miss)", () => {
      const filePath = "src/index.ts";
      const content = "console.log('clean log');";

      const res1 = scanFileWithCache(filePath, content, { cacheDir: tempDir });
      expect(res1.cached).toBe(false);
      expect(res1.result.violations).toHaveLength(0);

      // Second scan uses cache
      const res2 = scanFileWithCache(filePath, content, { cacheDir: tempDir });
      expect(res2.cached).toBe(true);
      expect(res2.result.path).toBe(filePath);
    });

    it("bypasses reading and writing cache when noCache: true", () => {
      const filePath = "src/test.ts";
      const content = "console.log('clean');";

      const res = scanFileWithCache(filePath, content, {
        cacheDir: tempDir,
        noCache: true,
      });
      expect(res.cached).toBe(false);

      // Verify nothing was written to cache
      const entry = getCacheEntry({ content, cacheDir: tempDir });
      expect(entry).toBeNull();
    });

    it("correctly remaps filePath on cache hit", () => {
      const content = "const duplicate = 100;";
      // Scan and cache as fileA.ts
      scanFileWithCache("fileA.ts", content, { cacheDir: tempDir });

      // Scan fileB.ts with same content
      const res = scanFileWithCache("fileB.ts", content, { cacheDir: tempDir });
      expect(res.cached).toBe(true);
      expect(res.result.path).toBe("fileB.ts");
    });
  });

  describe("7. scanFilesWithCache (Batch Scanning)", () => {
    it("first scan of unchanged repo analyzes all files; second scan analyzes 0 files", () => {
      const files = [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "src/b.ts", content: "export const b = 2;" },
        { path: "src/c.ts", content: "export const c = 3;" },
      ];

      // Scan 1: Cold cache -> 3 files analyzed, 0 cached
      const scan1 = scanFilesWithCache(files, { cacheDir: tempDir });
      expect(scan1.totalFiles).toBe(3);
      expect(scan1.analyzedCount).toBe(3);
      expect(scan1.cachedCount).toBe(0);
      expect(scan1.misses).toHaveLength(3);
      expect(scan1.hits).toHaveLength(0);

      // Scan 2: Unchanged repo -> 0 files analyzed, 3 cached
      const scan2 = scanFilesWithCache(files, { cacheDir: tempDir });
      expect(scan2.totalFiles).toBe(3);
      expect(scan2.analyzedCount).toBe(0);
      expect(scan2.cachedCount).toBe(3);
      expect(scan2.misses).toHaveLength(0);
      expect(scan2.hits).toHaveLength(3);
    });

    it("modifying one file invalidates only that file in repeat scan", () => {
      const filesV1 = [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "src/b.ts", content: "export const b = 2;" },
      ];

      scanFilesWithCache(filesV1, { cacheDir: tempDir });

      // Modify src/b.ts
      const filesV2 = [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "src/b.ts", content: "export const b = 'MODIFIED';" },
      ];

      const scan2 = scanFilesWithCache(filesV2, { cacheDir: tempDir });
      expect(scan2.analyzedCount).toBe(1);
      expect(scan2.cachedCount).toBe(1);
      expect(scan2.hits).toEqual(["src/a.ts"]);
      expect(scan2.misses).toEqual(["src/b.ts"]);
    });

    it("bumping ruleset version re-analyzes all files", () => {
      const files = [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "src/b.ts", content: "export const b = 2;" },
      ];

      scanFilesWithCache(files, { cacheDir: tempDir });

      // Bump ruleset version
      setRulesetVersion("1.1.0");

      const scan2 = scanFilesWithCache(files, { cacheDir: tempDir });
      expect(scan2.analyzedCount).toBe(2);
      expect(scan2.cachedCount).toBe(0);
    });
  });

  describe("8. parseDurationMs and parseSizeBytes", () => {
    it("parses duration strings accurately across units", () => {
      expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseDurationMs("24h")).toBe(24 * 60 * 60 * 1000);
      expect(parseDurationMs("30m")).toBe(30 * 60 * 1000);
      expect(parseDurationMs("3600s")).toBe(3600 * 1000);
      expect(parseDurationMs("500ms")).toBe(500);
      expect(parseDurationMs("10000")).toBe(10000);
      expect(parseDurationMs(5000)).toBe(5000);
      expect(parseDurationMs("invalid")).toBeNull();
      expect(parseDurationMs(null)).toBeNull();
      expect(parseDurationMs(undefined)).toBeNull();
    });

    it("parses size strings accurately across units", () => {
      expect(parseSizeBytes("50MB")).toBe(50 * 1024 * 1024);
      expect(parseSizeBytes("100M")).toBe(100 * 1024 * 1024);
      expect(parseSizeBytes("10KB")).toBe(10 * 1024);
      expect(parseSizeBytes("1GB")).toBe(1024 * 1024 * 1024);
      expect(parseSizeBytes("1024")).toBe(1024);
      expect(parseSizeBytes(2048)).toBe(2048);
      expect(parseSizeBytes("invalid")).toBeNull();
      expect(parseSizeBytes(null)).toBeNull();
      expect(parseSizeBytes(undefined)).toBeNull();
    });
  });

  describe("9. TTL Expiration Lifecycle", () => {
    it("returns cache entry when cachedAt is within TTL window", () => {
      const content = "const validTtl = 1;";
      const mockResult = { path: "valid.ts", violations: [] };

      setCacheEntry({
        filePath: "valid.ts",
        content,
        result: mockResult,
        cacheDir: tempDir,
      });

      const entry = getCacheEntry({
        content,
        cacheDir: tempDir,
        ttlMs: 60 * 1000, // 1 minute
      });

      expect(entry).not.toBeNull();
    });

    it("expires and unlinks cache entry when older than TTL window", () => {
      const content = "const expiredTtl = 2;";
      const hash = computeContentHash(content);
      const cacheFile = path.join(tempDir, `${hash}.json`);

      // Write an entry with cachedAt 2 hours ago
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const expiredEntry: CacheEntry = {
        version: 1,
        rulesetVersion: DEFAULT_RULESET_VERSION,
        contentHash: hash,
        filePath: "expired.ts",
        result: { path: "expired.ts", violations: [] },
        cachedAt: twoHoursAgo,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(expiredEntry), "utf-8");

      // Verify file initially exists
      expect(fs.existsSync(cacheFile)).toBe(true);

      // Query with 1 hour TTL: should miss and unlink file
      const entry = getCacheEntry({
        content,
        cacheDir: tempDir,
        ttlMs: 60 * 60 * 1000, // 1 hour TTL
      });

      expect(entry).toBeNull();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("respects SECUREFLOW_CACHE_TTL environment variable", () => {
      process.env.SECUREFLOW_CACHE_TTL = "1h";
      try {
        const content = "const envTtl = 3;";
        const hash = computeContentHash(content);
        const cacheFile = path.join(tempDir, `${hash}.json`);

        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        const expiredEntry: CacheEntry = {
          version: 1,
          rulesetVersion: DEFAULT_RULESET_VERSION,
          contentHash: hash,
          filePath: "env.ts",
          result: { path: "env.ts", violations: [] },
          cachedAt: twoHoursAgo,
        };
        fs.writeFileSync(cacheFile, JSON.stringify(expiredEntry), "utf-8");

        const entry = getCacheEntry({ content, cacheDir: tempDir });
        expect(entry).toBeNull();
        expect(fs.existsSync(cacheFile)).toBe(false);
      } finally {
        delete process.env.SECUREFLOW_CACHE_TTL;
      }
    });
  });

  describe("10. Storage Limits & LRU Eviction", () => {
    it("evicts oldest entries when cache directory exceeds max storage budget", () => {
      // Create 3 entries with staggered timestamps
      const entries = [
        { name: "oldest", content: "export const a = 'oldest';", time: 1000 },
        { name: "middle", content: "export const b = 'middle';", time: 2000 },
        { name: "newest", content: "export const c = 'newest';", time: 3000 },
      ];

      for (const item of entries) {
        const hash = computeContentHash(item.content);
        const entry: CacheEntry = {
          version: 1,
          rulesetVersion: DEFAULT_RULESET_VERSION,
          contentHash: hash,
          filePath: `${item.name}.ts`,
          result: { path: `${item.name}.ts`, violations: [] },
          cachedAt: item.time,
        };
        fs.writeFileSync(
          path.join(tempDir, `${hash}.json`),
          JSON.stringify(entry, null, 2),
          "utf-8",
        );
      }

      // Check stats: 3 entries
      const initialStats = getCacheStats(tempDir);
      expect(initialStats.entryCount).toBe(3);

      // Enforce a tight budget that forces eviction
      const smallBudget = Math.floor(initialStats.totalSizeBytes * 0.7);
      const lruResult = enforceCacheStorageLimit(tempDir, smallBudget);

      expect(lruResult.evictedCount).toBeGreaterThan(0);
      expect(lruResult.freedBytes).toBeGreaterThan(0);

      // Oldest entry should be evicted first
      const oldestHash = computeContentHash(entries[0]!.content);
      expect(fs.existsSync(path.join(tempDir, `${oldestHash}.json`))).toBe(false);

      // Newest entry should remain
      const newestHash = computeContentHash(entries[2]!.content);
      expect(fs.existsSync(path.join(tempDir, `${newestHash}.json`))).toBe(true);
    });

    it("automatically triggers LRU eviction in setCacheEntry when limit is exceeded", () => {
      // Write entry 1
      setCacheEntry({
        filePath: "1.ts",
        content: "const a = 1;",
        result: { path: "1.ts", violations: [] },
        cacheDir: tempDir,
      });

      const initialSize = getCacheStats(tempDir).totalSizeBytes;

      // Write entry 2 with maxSizeBytes set lower than 2 entries
      setCacheEntry({
        filePath: "2.ts",
        content: "const b = 2;",
        result: { path: "2.ts", violations: [] },
        cacheDir: tempDir,
        maxSizeBytes: initialSize + 10,
      });

      const finalStats = getCacheStats(tempDir);
      // Entry 2 should exist
      const entry2 = getCacheEntry({ content: "const b = 2;", cacheDir: tempDir });
      expect(entry2).not.toBeNull();
      // Total size should not exceed maxSizeBytes
      expect(finalStats.totalSizeBytes).toBeLessThanOrEqual(initialSize + 10);
    });
  });

  describe("11. Orphaned Temp File Reaping", () => {
    it("sweeps .tmp files older than max age while leaving fresh .tmp files alone", () => {
      const oldTmp = path.join(tempDir, ".old.tmp");
      const freshTmp = path.join(tempDir, ".fresh.tmp");

      fs.writeFileSync(oldTmp, "temp old", "utf-8");
      fs.writeFileSync(freshTmp, "temp fresh", "utf-8");

      // Backdate oldTmp mtime to 2 hours ago
      const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

      const reaped = reapOrphanedTempFiles(tempDir, 60 * 60 * 1000); // 1 hour max age
      expect(reaped).toBe(1);
      expect(fs.existsSync(oldTmp)).toBe(false);
      expect(fs.existsSync(freshTmp)).toBe(true);
    });
  });

  describe("12. pruneCache", () => {
    it("selectively prunes entries exceeding TTL without wiping active entries", () => {
      const freshContent = "const fresh = 'keep';";
      const staleContent = "const stale = 'prune';";

      // Write fresh entry
      setCacheEntry({
        filePath: "fresh.ts",
        content: freshContent,
        result: { path: "fresh.ts", violations: [] },
        cacheDir: tempDir,
      });

      // Write stale entry (10 days old)
      const staleHash = computeContentHash(staleContent);
      const staleEntry: CacheEntry = {
        version: 1,
        rulesetVersion: DEFAULT_RULESET_VERSION,
        contentHash: staleHash,
        filePath: "stale.ts",
        result: { path: "stale.ts", violations: [] },
        cachedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      };
      fs.writeFileSync(
        path.join(tempDir, `${staleHash}.json`),
        JSON.stringify(staleEntry),
        "utf-8",
      );

      // Prune with 7d TTL
      const result = pruneCache({
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        cacheDir: tempDir,
      });

      expect(result.prunedCount).toBe(1);
      expect(result.remainingCount).toBe(1);
      expect(getCacheEntry({ content: freshContent, cacheDir: tempDir })).not.toBeNull();
      expect(getCacheEntry({ content: staleContent, cacheDir: tempDir })).toBeNull();
    });

    it("returns zero pruned count for already clean or empty cache", () => {
      const result = pruneCache({ cacheDir: tempDir, ttlMs: 100000 });
      expect(result.prunedCount).toBe(0);
      expect(result.remainingCount).toBe(0);
    });
  });

  describe("13. getCacheStats", () => {
    it("reports zero stats for empty cache directory", () => {
      const stats = getCacheStats(tempDir);
      expect(stats.entryCount).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.tempFileCount).toBe(0);
      expect(stats.oldestEntryAt).toBeNull();
      expect(stats.newestEntryAt).toBeNull();
    });

    it("aggregates entries, disk size, ruleset versions, and timestamps", () => {
      setRulesetVersion("1.0.0");
      setCacheEntry({
        filePath: "1.ts",
        content: "content1",
        result: { path: "1.ts", violations: [] },
        cacheDir: tempDir,
      });

      setRulesetVersion("2.0.0");
      setCacheEntry({
        filePath: "2.ts",
        content: "content2",
        result: { path: "2.ts", violations: [] },
        cacheDir: tempDir,
      });

      fs.writeFileSync(path.join(tempDir, ".abandoned.tmp"), "temp", "utf-8");

      const stats = getCacheStats(tempDir);
      expect(stats.entryCount).toBe(2);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
      expect(stats.tempFileCount).toBe(1);
      expect(stats.oldestEntryAt).not.toBeNull();
      expect(stats.newestEntryAt).not.toBeNull();
      expect(stats.rulesetVersions["1.0.0"]).toBe(1);
      expect(stats.rulesetVersions["2.0.0"]).toBe(1);
    });
  });
});
