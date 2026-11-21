/**
 * Content hash and ruleset version caching for SecureFlow scanner.
 *
 * Speeds up repeat scans of unchanged repositories by storing findings keyed
 * by file content hash (SHA-256) and ruleset version.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scanFile, type FileScanResult } from "./scanner.js";
import { getRepoRoot } from "./git.js";
import type { AiFinding } from "./lib/api-client.js";

export const DEFAULT_RULESET_VERSION = "1.0.0";
export const DEFAULT_CACHE_SUBDIR = path.join(".secureflow", "cache");

let activeRulesetVersion = DEFAULT_RULESET_VERSION;

/**
 * Get the current active ruleset version.
 */
export function getRulesetVersion(): string {
  return activeRulesetVersion;
}

/**
 * Set the active ruleset version (e.g. for testing ruleset invalidation).
 */
export function setRulesetVersion(version: string): void {
  activeRulesetVersion = version;
}

/**
 * Reset the active ruleset version to default.
 */
export function resetRulesetVersion(): void {
  activeRulesetVersion = DEFAULT_RULESET_VERSION;
}

/**
 * Compute SHA-256 hash of file content.
 */
export function computeContentHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Safely removes a file without throwing if it does not exist or cannot be accessed.
 */
function safeRemoveFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore removal errors
  }
}

/**
 * Resolves the cache directory location.
 * Priority:
 * 1. customDir parameter (if provided)
 * 2. SECUREFLOW_CACHE_DIR environment variable (if set)
 * 3. Default: `<repoRoot>/.secureflow/cache`
 */
export function resolveCacheDir(customDir?: string, cwd?: string): string {
  if (customDir) {
    return path.resolve(customDir);
  }
  if (process.env.SECUREFLOW_CACHE_DIR) {
    return path.resolve(process.env.SECUREFLOW_CACHE_DIR);
  }
  const root = getRepoRoot(cwd);
  return path.join(root, DEFAULT_CACHE_SUBDIR);
}

export interface CacheEntry {
  version: number;
  rulesetVersion: string;
  contentHash: string;
  filePath: string;
  result: FileScanResult;
  aiFindings?: AiFinding[] | undefined;
  cachedAt: number;
}

export interface GetCacheEntryOptions {
  contentHash?: string | undefined;
  content?: string | undefined;
  filePath?: string | undefined;
  cacheDir?: string | undefined;
  rulesetVersion?: string | undefined;
}

/**
 * Retrieves a cached scan result if one exists matching the content hash and ruleset version.
 * Returns null if not found, invalidated by ruleset change, or corrupt.
 */
export function getCacheEntry(options: GetCacheEntryOptions): CacheEntry | null {
  const hash =
    options.contentHash ??
    (options.content !== undefined ? computeContentHash(options.content) : null);
  if (!hash) return null;

  const targetRuleset = options.rulesetVersion ?? getRulesetVersion();
  const cacheDir = resolveCacheDir(options.cacheDir);
  const cacheFile = path.join(cacheDir, `${hash}.json`);

  if (!fs.existsSync(cacheFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(cacheFile, "utf-8");
    if (!raw || raw.trim().length === 0) {
      safeRemoveFile(cacheFile);
      return null;
    }

    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed !== "object") {
      safeRemoveFile(cacheFile);
      return null;
    }

    // Invalidation: Ruleset version mismatch
    if (parsed.rulesetVersion !== targetRuleset) {
      return null;
    }

    // Invalidation: Content hash mismatch
    if (parsed.contentHash !== hash) {
      safeRemoveFile(cacheFile);
      return null;
    }

    // Validation: Result object must have violations array
    if (
      !parsed.result ||
      typeof parsed.result !== "object" ||
      !Array.isArray(parsed.result.violations)
    ) {
      safeRemoveFile(cacheFile);
      return null;
    }

    return parsed;
  } catch {
    // Gracefully handle corrupt cache file: treat as miss and clean up
    safeRemoveFile(cacheFile);
    return null;
  }
}

export interface SetCacheEntryOptions {
  filePath: string;
  content?: string | undefined;
  contentHash?: string | undefined;
  result: FileScanResult;
  aiFindings?: AiFinding[] | undefined;
  cacheDir?: string | undefined;
  rulesetVersion?: string | undefined;
}

/**
 * Writes a scan result to the local cache directory keyed by content hash.
 */
export function setCacheEntry(options: SetCacheEntryOptions): void {
  const hash =
    options.contentHash ??
    (options.content !== undefined ? computeContentHash(options.content) : null);
  if (!hash) return;

  const rulesetVersion = options.rulesetVersion ?? getRulesetVersion();
  const cacheDir = resolveCacheDir(options.cacheDir);
  const cacheFile = path.join(cacheDir, `${hash}.json`);

  const entry: CacheEntry = {
    version: 1,
    rulesetVersion,
    contentHash: hash,
    filePath: options.filePath,
    result: options.result,
    aiFindings: options.aiFindings ?? [],
    cachedAt: Date.now(),
  };

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmpFile = path.join(
      cacheDir,
      `.${hash}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmpFile, JSON.stringify(entry, null, 2), "utf-8");
    try {
      fs.renameSync(tmpFile, cacheFile);
    } catch {
      fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
      safeRemoveFile(tmpFile);
    }
  } catch {
    // Non-fatal write failure (e.g. read-only filesystem or disk full)
  }
}

export interface ClearCacheResult {
  cleared: boolean;
  count: number;
  cacheDir: string;
}

/**
 * Clears all cached scan entries in the cache directory.
 */
export function clearCache(customDir?: string, cwd?: string): ClearCacheResult {
  const cacheDir = resolveCacheDir(customDir, cwd);
  if (!fs.existsSync(cacheDir)) {
    return { cleared: true, count: 0, cacheDir };
  }

  try {
    const files = fs.readdirSync(cacheDir);
    let count = 0;
    for (const file of files) {
      if (file.endsWith(".json") || file.endsWith(".tmp")) {
        try {
          fs.unlinkSync(path.join(cacheDir, file));
          count++;
        } catch {
          // Ignore individual delete failures
        }
      }
    }
    return { cleared: true, count, cacheDir };
  } catch {
    return { cleared: false, count: 0, cacheDir };
  }
}

export interface ScanFileWithCacheOptions {
  customIgnores?: RegExp[] | undefined;
  cacheDir?: string | undefined;
  rulesetVersion?: string | undefined;
  noCache?: boolean | undefined;
}

export interface ScanFileWithCacheResult {
  result: FileScanResult;
  cached: boolean;
  contentHash: string;
  aiFindings?: AiFinding[] | undefined;
}

/**
 * Scan a single file with content hash caching.
 * Reuses cached findings if available, or analyzes and caches on miss.
 */
export function scanFileWithCache(
  filePath: string,
  content: string,
  options: ScanFileWithCacheOptions = {},
): ScanFileWithCacheResult {
  const contentHash = computeContentHash(content);

  if (!options.noCache) {
    const cachedEntry = getCacheEntry({
      filePath,
      contentHash,
      cacheDir: options.cacheDir,
      rulesetVersion: options.rulesetVersion,
    });

    if (cachedEntry) {
      return {
        result: {
          ...cachedEntry.result,
          path: filePath,
        },
        cached: true,
        contentHash,
        aiFindings: cachedEntry.aiFindings?.map((f) => ({
          ...f,
          fileLocation: filePath,
        })),
      };
    }
  }

  // Cache miss or --no-cache: analyze file
  const result = scanFile(filePath, content, options.customIgnores);

  if (!options.noCache) {
    setCacheEntry({
      filePath,
      contentHash,
      result,
      cacheDir: options.cacheDir,
      rulesetVersion: options.rulesetVersion,
    });
  }

  return {
    result,
    cached: false,
    contentHash,
  };
}

export interface BatchScanResult {
  fileResults: FileScanResult[];
  analyzedCount: number;
  cachedCount: number;
  totalFiles: number;
  hits: string[];
  misses: string[];
  cachedAiFindings: AiFinding[];
  stagedForAi: Array<{ path: string; content: string }>;
}

/**
 * Scan multiple files in batch with content hash caching.
 */
export function scanFilesWithCache(
  files: Array<{ path: string; content: string }>,
  options: ScanFileWithCacheOptions = {},
): BatchScanResult {
  const fileResults: FileScanResult[] = [];
  const hits: string[] = [];
  const misses: string[] = [];
  const cachedAiFindings: AiFinding[] = [];
  const stagedForAi: Array<{ path: string; content: string }> = [];

  for (const { path: filePath, content } of files) {
    const scan = scanFileWithCache(filePath, content, options);
    fileResults.push(scan.result);

    if (scan.cached) {
      hits.push(filePath);
      if (scan.aiFindings && scan.aiFindings.length > 0) {
        cachedAiFindings.push(...scan.aiFindings);
      }
    } else {
      misses.push(filePath);
      if (!scan.result.skipped) {
        stagedForAi.push({ path: filePath, content });
      }
    }
  }

  return {
    fileResults,
    analyzedCount: misses.length,
    cachedCount: hits.length,
    totalFiles: files.length,
    hits,
    misses,
    cachedAiFindings,
    stagedForAi,
  };
}
