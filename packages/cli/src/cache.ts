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

export const DEFAULT_RULESET_VERSION = "1.0.1";
export const DEFAULT_CACHE_SUBDIR = path.join(".secureflow", "cache");
export const DEFAULT_MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_ORPHANED_TEMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_LOCK_TIMEOUT_MS = 2000; // 2 seconds
export const DEFAULT_STALE_LOCK_MS = 10000; // 10 seconds

/**
 * Parses duration string (e.g. "7d", "24h", "30m", "3600s", or raw ms) to milliseconds.
 */
export function parseDurationMs(durationStr: string | number | undefined | null): number | null {
  if (typeof durationStr === "number") {
    return durationStr >= 0 ? durationStr : null;
  }
  if (!durationStr || typeof durationStr !== "string") return null;
  const trimmed = durationStr.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(trimmed);
  if (!match) return null;
  const num = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  switch (unit) {
    case "d":
    case "day":
    case "days":
      return Math.round(num * 24 * 60 * 60 * 1000);
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return Math.round(num * 60 * 60 * 1000);
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return Math.round(num * 60 * 1000);
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return Math.round(num * 1000);
    case "ms":
      return Math.round(num);
    default:
      return null;
  }
}

/**
 * Parses size string (e.g. "50MB", "100M", "10KB", "1GB", or raw bytes) to bytes.
 */
export function parseSizeBytes(sizeStr: string | number | undefined | null): number | null {
  if (typeof sizeStr === "number") {
    return sizeStr >= 0 ? sizeStr : null;
  }
  if (!sizeStr || typeof sizeStr !== "string") return null;
  const trimmed = sizeStr.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(trimmed);
  if (!match) return null;
  const num = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  switch (unit) {
    case "B":
    case "BYTES":
      return Math.round(num);
    case "K":
    case "KB":
    case "KIB":
      return Math.round(num * 1024);
    case "M":
    case "MB":
    case "MIB":
      return Math.round(num * 1024 * 1024);
    case "G":
    case "GB":
    case "GIB":
      return Math.round(num * 1024 * 1024 * 1024);
    default:
      return null;
  }
}

function isTempOrLockFile(filename: string): boolean {
  return (
    filename.endsWith(".tmp") || /\.tmp_[^/\\]+$/.test(filename) || filename.startsWith(".lock_")
  );
}

/**
 * Removes temporary files (.tmp, .tmp_*, and stale .lock_*) in the cache directory
 * that exceed the maximum age.
 */
export function reapOrphanedTempFiles(
  cacheDir: string,
  maxAgeMs = DEFAULT_ORPHANED_TEMP_MAX_AGE_MS,
): number {
  if (!fs.existsSync(cacheDir)) return 0;
  let reaped = 0;
  const now = Date.now();
  try {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (isTempOrLockFile(file)) {
        const fullPath = path.join(cacheDir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            safeRemoveFile(fullPath);
            reaped++;
          }
        } catch {
          // ignore individual stat/remove errors
        }
      }
    }
  } catch {
    // ignore read directory errors
  }
  return reaped;
}

/**
 * Enforces maximum cache directory size by evicting least-recently used / oldest entries.
 * Evicts until directory size is reduced to target headroom (80% of maxSizeBytes).
 */
export function enforceCacheStorageLimit(
  cacheDir: string,
  maxSizeBytes = DEFAULT_MAX_CACHE_SIZE_BYTES,
  preserveHash?: string,
): { evictedCount: number; freedBytes: number } {
  if (!fs.existsSync(cacheDir) || maxSizeBytes <= 0) {
    return { evictedCount: 0, freedBytes: 0 };
  }

  try {
    const files = fs.readdirSync(cacheDir);
    const jsonFiles: Array<{ path: string; hash: string; size: number; timestamp: number }> = [];
    let totalSize = 0;

    for (const file of files) {
      if (file.endsWith(".json")) {
        const fullPath = path.join(cacheDir, file);
        const fileHash = file.slice(0, -5);
        try {
          const stat = fs.statSync(fullPath);
          totalSize += stat.size;
          let timestamp = stat.mtimeMs;
          try {
            const raw = fs.readFileSync(fullPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.cachedAt === "number") {
              timestamp = parsed.cachedAt;
            }
          } catch {
            // keep stat.mtimeMs
          }
          jsonFiles.push({ path: fullPath, hash: fileHash, size: stat.size, timestamp });
        } catch {
          // ignore stat errors
        }
      }
    }

    if (totalSize <= maxSizeBytes) {
      return { evictedCount: 0, freedBytes: 0 };
    }

    const targetSize = Math.floor(maxSizeBytes * 0.8);
    // Sort oldest first (LRU order)
    jsonFiles.sort((a, b) => a.timestamp - b.timestamp);

    let evictedCount = 0;
    let freedBytes = 0;

    for (const item of jsonFiles) {
      if (preserveHash && item.hash === preserveHash) {
        continue;
      }
      if (totalSize - freedBytes <= targetSize) {
        break;
      }
      safeRemoveFile(item.path);
      evictedCount++;
      freedBytes += item.size;
    }

    return { evictedCount, freedBytes };
  } catch {
    return { evictedCount: 0, freedBytes: 0 };
  }
}

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
  checksum?: string | undefined;
}

export interface CacheLockOptions {
  timeoutMs?: number | undefined;
  staleLockMs?: number | undefined;
}

function syncSleepMs(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback busy-wait only if SharedArrayBuffer is unavailable
    }
  }
}

/**
 * Computes a deterministic SHA-256 checksum over the cache entry payload.
 */
export function computeEntryChecksum(entry: Omit<CacheEntry, "checksum">): string {
  const canonical = JSON.stringify({
    version: entry.version,
    rulesetVersion: entry.rulesetVersion,
    contentHash: entry.contentHash,
    filePath: entry.filePath,
    result: entry.result,
    aiFindings: entry.aiFindings ?? [],
    cachedAt: entry.cachedAt,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Acquires a cooperative advisory lockfile (`.lock_<hash>`) using exclusive file creation (`wx`),
 * exponential backoff polling, and automatic stale lock eviction.
 */
export function acquireCacheLock(
  cacheDir: string,
  hash: string,
  options: CacheLockOptions = {},
): boolean {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = path.join(cacheDir, `.lock_${hash}`);
  const deadline = Date.now() + timeoutMs;
  let backoffMs = 5;

  fs.mkdirSync(cacheDir, { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        const lockMeta = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
        fs.writeFileSync(fd, lockMeta, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        return false;
      }

      // Check if existing lock is stale and can be reclaimed
      try {
        const stat = fs.statSync(lockPath);
        let lockTimestamp = stat.mtimeMs;
        try {
          const raw = fs.readFileSync(lockPath, "utf-8");
          const parsed = JSON.parse(raw) as { acquiredAt?: number };
          if (typeof parsed?.acquiredAt === "number") {
            lockTimestamp = parsed.acquiredAt;
          }
        } catch {
          // fallback to stat.mtimeMs if lock file is partially written or empty
        }

        if (Date.now() - lockTimestamp > staleLockMs) {
          safeRemoveFile(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared concurrently; retry immediately
        continue;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      const jitter = Math.floor(Math.random() * 5);
      const waitMs = Math.min(backoffMs + jitter, Math.max(1, deadline - Date.now()));
      syncSleepMs(waitMs);
      backoffMs = Math.min(backoffMs * 2, 100);
    }
  }
}

/**
 * Releases the cooperative advisory lockfile for a given cache hash.
 */
export function releaseCacheLock(cacheDir: string, hash: string): void {
  const lockPath = path.join(cacheDir, `.lock_${hash}`);
  safeRemoveFile(lockPath);
}

export interface GetCacheEntryOptions {
  contentHash?: string | undefined;
  content?: string | undefined;
  filePath?: string | undefined;
  cacheDir?: string | undefined;
  rulesetVersion?: string | undefined;
  ttlMs?: number | undefined;
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

    // Invalidation: TTL expiration
    const ttl =
      options.ttlMs ??
      (process.env.SECUREFLOW_CACHE_TTL
        ? (parseDurationMs(process.env.SECUREFLOW_CACHE_TTL) ?? undefined)
        : undefined);
    if (ttl !== undefined && ttl > 0 && typeof parsed.cachedAt === "number") {
      if (Date.now() - parsed.cachedAt > ttl) {
        safeRemoveFile(cacheFile);
        return null;
      }
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

    // Integrity verification: validate SHA-256 payload checksum if present
    if (parsed.checksum !== undefined) {
      const expectedChecksum = computeEntryChecksum(parsed);
      if (parsed.checksum !== expectedChecksum) {
        safeRemoveFile(cacheFile);
        return null;
      }
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
  maxSizeBytes?: number | undefined;
}

/**
 * Writes a scan result to the local cache directory keyed by content hash
 * using cooperative file locking and atomic temp-file rename-into-place.
 */
export function setCacheEntry(options: SetCacheEntryOptions): void {
  const hash =
    options.contentHash ??
    (options.content !== undefined ? computeContentHash(options.content) : null);
  if (!hash) return;

  const rulesetVersion = options.rulesetVersion ?? getRulesetVersion();
  const cacheDir = resolveCacheDir(options.cacheDir);
  const cacheFile = path.join(cacheDir, `${hash}.json`);

  const baseEntry: Omit<CacheEntry, "checksum"> = {
    version: 1,
    rulesetVersion,
    contentHash: hash,
    filePath: options.filePath,
    result: options.result,
    aiFindings: options.aiFindings ?? [],
    cachedAt: Date.now(),
  };

  const entry: CacheEntry = {
    ...baseEntry,
    checksum: computeEntryChecksum(baseEntry),
  };

  let locked = false;
  let tmpFile: string | null = null;

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    locked = acquireCacheLock(cacheDir, hash);
    if (!locked) {
      return;
    }

    const nonce = crypto.randomBytes(4).toString("hex");
    tmpFile = path.join(cacheDir, `${hash}.json.tmp_${process.pid}_${Date.now()}_${nonce}`);
    fs.writeFileSync(tmpFile, JSON.stringify(entry, null, 2), "utf-8");

    // Atomic rename-into-place (retry briefly on Windows transient EPERM/EACCES)
    let renamed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tmpFile, cacheFile);
        renamed = true;
        break;
      } catch {
        syncSleepMs(10 * (attempt + 1));
      }
    }

    if (!renamed) {
      safeRemoveFile(tmpFile);
    }

    // Storage budget management: LRU eviction and temp file cleanup
    const maxBytes =
      options.maxSizeBytes ??
      (process.env.SECUREFLOW_CACHE_MAX_SIZE
        ? (parseSizeBytes(process.env.SECUREFLOW_CACHE_MAX_SIZE) ?? DEFAULT_MAX_CACHE_SIZE_BYTES)
        : DEFAULT_MAX_CACHE_SIZE_BYTES);
    enforceCacheStorageLimit(cacheDir, maxBytes, hash);
    reapOrphanedTempFiles(cacheDir);
  } catch {
    if (tmpFile) {
      safeRemoveFile(tmpFile);
    }
    // Non-fatal write failure (e.g. read-only filesystem or disk full)
  } finally {
    if (locked) {
      releaseCacheLock(cacheDir, hash);
    }
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
      if (file.endsWith(".json") || isTempOrLockFile(file)) {
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

export interface PruneCacheOptions {
  ttlMs?: number | undefined;
  maxSizeBytes?: number | undefined;
  cacheDir?: string | undefined;
  cwd?: string | undefined;
}

export interface PruneCacheResult {
  prunedCount: number;
  freedBytes: number;
  remainingCount: number;
  remainingBytes: number;
  cacheDir: string;
}

/**
 * Prunes expired or excess cache entries according to TTL and storage limit.
 */
export function pruneCache(options: PruneCacheOptions = {}): PruneCacheResult {
  const cacheDir = resolveCacheDir(options.cacheDir, options.cwd);
  if (!fs.existsSync(cacheDir)) {
    return { prunedCount: 0, freedBytes: 0, remainingCount: 0, remainingBytes: 0, cacheDir };
  }

  // 1. Clean up orphaned temp files
  reapOrphanedTempFiles(cacheDir, 0);

  let prunedCount = 0;
  let freedBytes = 0;
  const now = Date.now();
  const ttl = options.ttlMs;

  try {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const fullPath = path.join(cacheDir, file);
        try {
          const stat = fs.statSync(fullPath);
          let shouldPrune = false;
          try {
            const raw = fs.readFileSync(fullPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.cachedAt !== "number") {
              shouldPrune = true;
            } else if (ttl !== undefined && ttl > 0 && now - parsed.cachedAt > ttl) {
              shouldPrune = true;
            }
          } catch {
            shouldPrune = true;
          }

          if (shouldPrune) {
            safeRemoveFile(fullPath);
            prunedCount++;
            freedBytes += stat.size;
          }
        } catch {
          // ignore file stat errors
        }
      }
    }

    // 2. Enforce maximum size limit if provided
    if (options.maxSizeBytes !== undefined && options.maxSizeBytes > 0) {
      const lruResult = enforceCacheStorageLimit(cacheDir, options.maxSizeBytes);
      prunedCount += lruResult.evictedCount;
      freedBytes += lruResult.freedBytes;
    }

    // 3. Compute remaining stats
    let remainingCount = 0;
    let remainingBytes = 0;
    const remainingFiles = fs.readdirSync(cacheDir);
    for (const file of remainingFiles) {
      if (file.endsWith(".json")) {
        try {
          const stat = fs.statSync(path.join(cacheDir, file));
          remainingCount++;
          remainingBytes += stat.size;
        } catch {
          // ignore
        }
      }
    }

    return {
      prunedCount,
      freedBytes,
      remainingCount,
      remainingBytes,
      cacheDir,
    };
  } catch {
    return { prunedCount, freedBytes, remainingCount: 0, remainingBytes: 0, cacheDir };
  }
}

export interface CacheStatsReport {
  cacheDir: string;
  entryCount: number;
  totalSizeBytes: number;
  tempFileCount: number;
  tempSizeBytes: number;
  oldestEntryAt: number | null;
  newestEntryAt: number | null;
  rulesetVersions: Record<string, number>;
}

/**
 * Returns diagnostic statistics about the scan cache.
 */
export function getCacheStats(customDir?: string, cwd?: string): CacheStatsReport {
  const cacheDir = resolveCacheDir(customDir, cwd);
  const report: CacheStatsReport = {
    cacheDir,
    entryCount: 0,
    totalSizeBytes: 0,
    tempFileCount: 0,
    tempSizeBytes: 0,
    oldestEntryAt: null,
    newestEntryAt: null,
    rulesetVersions: {},
  };

  if (!fs.existsSync(cacheDir)) {
    return report;
  }

  try {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      const fullPath = path.join(cacheDir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (file.endsWith(".tmp")) {
          report.tempFileCount++;
          report.tempSizeBytes += stat.size;
        } else if (file.endsWith(".json")) {
          report.entryCount++;
          report.totalSizeBytes += stat.size;

          try {
            const raw = fs.readFileSync(fullPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.cachedAt === "number") {
              const ts = parsed.cachedAt;
              if (report.oldestEntryAt === null || ts < report.oldestEntryAt) {
                report.oldestEntryAt = ts;
              }
              if (report.newestEntryAt === null || ts > report.newestEntryAt) {
                report.newestEntryAt = ts;
              }
            }
            if (parsed && typeof parsed.rulesetVersion === "string") {
              report.rulesetVersions[parsed.rulesetVersion] =
                (report.rulesetVersions[parsed.rulesetVersion] ?? 0) + 1;
            }
          } catch {
            // ignore parse errors in stats
          }
        }
      } catch {
        // ignore stat errors
      }
    }
  } catch {
    // ignore directory read errors
  }

  return report;
}

export interface ScanFileWithCacheOptions {
  customIgnores?: RegExp[] | undefined;
  customRules?: import("./custom-rules.js").CompiledCustomRule[] | undefined;
  cacheDir?: string | undefined;
  rulesetVersion?: string | undefined;
  noCache?: boolean | undefined;
  ttlMs?: number | undefined;
  maxSizeBytes?: number | undefined;
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
      ttlMs: options.ttlMs,
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
  const result = scanFile(filePath, content, options.customIgnores, options.customRules);

  if (!options.noCache) {
    setCacheEntry({
      filePath,
      contentHash,
      result,
      cacheDir: options.cacheDir,
      rulesetVersion: options.rulesetVersion,
      maxSizeBytes: options.maxSizeBytes,
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
