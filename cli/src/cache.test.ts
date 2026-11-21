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
});
