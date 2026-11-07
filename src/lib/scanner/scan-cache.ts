/**
 * Scan Cache Layer
 *
 * Deduplicates synchronize / force-push / empty rebase scan requests when the
 * normalized diff and active policy set have not changed.
 *
 * Before calling the LLM, look up the hash in a cache (Redis if available,
 * otherwise Prisma table `scanCache`) and reuse the stored findings.
 */

import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { parseUnifiedPatch, renderNumberedLines } from "@/lib/armor/diff";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";
import { getPolicyVersion } from "@/lib/policies/policy-cache";

export const DEFAULT_SCAN_CACHE_TTL_SECONDS = 86400; // 24 hours
export const SCAN_CACHE_PREFIX = "scan-cache:";

/**
 * Reads the scan cache TTL from SCAN_CACHE_TTL_SECONDS or LLM_CACHE_TTL_SECONDS.
 * Falls back to 24 hours (86400s) if unset, non-numeric, or not positive.
 */
export function getScanCacheTtlSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SCAN_CACHE_TTL_SECONDS || env.LLM_CACHE_TTL_SECONDS;
  if (!raw) return DEFAULT_SCAN_CACHE_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCAN_CACHE_TTL_SECONDS;
}

/**
 * Normalizes diff content across files.
 * Extracts numbered added/context lines via parseUnifiedPatch to eliminate
 * formatting or whitespace artifacts while preserving semantic diff content.
 */
export function normalizeDiff(files: FileChange[]): string {
  // Sort files deterministically by filename
  const sortedFiles = [...files].sort((a, b) => a.filename.localeCompare(b.filename));

  return sortedFiles
    .map((file) => {
      const parsed = parseUnifiedPatch(file.patch || "");
      const rendered = renderNumberedLines(parsed);
      return `<file name="${file.filename}">\n${rendered}\n</file>`;
    })
    .join("\n");
}

export interface ComputeScanCacheHashInput {
  files: FileChange[];
  activePolicies: Array<{
    description?: string;
    id?: string;
    name?: string;
    severity?: string;
    [key: string]: unknown;
  }>;
  policyVersion?: string;
  customIgnores?: string[];
  customPlaceholders?: string[];
}

/**
 * Computes a deterministic SHA-256 hash of the normalized diff,
 * the active policy set, and the policy version.
 */
export function computeScanCacheHash(input: ComputeScanCacheHashInput): string {
  const normalizedDiff = normalizeDiff(input.files);

  // Normalize active policies deterministically
  const normalizedPolicies = (input.activePolicies || [])
    .map((p) => ({
      id: p.id ?? "",
      name: p.name ?? "",
      description: p.description ?? "",
      severity: p.severity ?? "",
    }))
    .sort((a, b) => (a.id || a.description).localeCompare(b.id || b.description));

  const payload = JSON.stringify({
    diff: normalizedDiff,
    policies: normalizedPolicies,
    policyVersion: input.policyVersion ?? "1.0.0",
    customIgnores: (input.customIgnores || []).slice().sort(),
    customPlaceholders: (input.customPlaceholders || []).slice().sort(),
  });

  return createHash("sha256").update(payload).digest("hex");
}

export function scanCacheKey(hash: string): string {
  return `${SCAN_CACHE_PREFIX}${hash}`;
}

export interface CachedScanData {
  findings: ScanFinding[];
  cachedAt: string;
}

/**
 * Attempt to retrieve cached findings by cache key.
 * Checks Redis first if configured; falls back to Prisma `ScanCache`.
 */
export async function getCachedScan(
  key: string,
  deps: { redisClient?: typeof redis; db?: typeof prisma } = {},
): Promise<ScanFinding[] | null> {
  const redisClient = deps.redisClient !== undefined ? deps.redisClient : redis;
  const db = deps.db !== undefined ? deps.db : prisma;

  // 1. Try Redis
  if (redisClient) {
    try {
      const cached = await redisClient.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedScanData | ScanFinding[];
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.findings)) return parsed.findings;
      }
    } catch (err) {
      console.warn("[SCAN_CACHE] Redis read failed, checking database fallback:", err);
    }
  }

  // 2. Try Prisma fallback
  if (db && typeof db.scanCache?.findUnique === "function") {
    try {
      const record = await db.scanCache.findUnique({
        where: { cacheKey: key },
        select: { id: true, findingsJson: true, expiresAt: true },
      });

      if (record) {
        if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
          // Asynchronously clean up expired entry
          db.scanCache.delete({ where: { cacheKey: key } }).catch(() => {});
          return null;
        }

        db.scanCache
          .update({
            where: { cacheKey: key },
            data: {
              hitCount: { increment: 1 },
              lastAccessed: new Date(),
            },
          })
          .catch(() => {});

        const parsed = JSON.parse(record.findingsJson) as ScanFinding[];
        return Array.isArray(parsed) ? parsed : null;
      }
    } catch (err) {
      console.warn("[SCAN_CACHE] Database read failed:", err);
    }
  }

  return null;
}

/**
 * Store scan findings in cache (Redis and/or Prisma).
 */
export async function setCachedScan(
  key: string,
  findings: ScanFinding[],
  ttlSeconds: number = getScanCacheTtlSeconds(),
  deps: { redisClient?: typeof redis; db?: typeof prisma } = {},
): Promise<void> {
  const redisClient = deps.redisClient !== undefined ? deps.redisClient : redis;
  const db = deps.db !== undefined ? deps.db : prisma;
  const data: CachedScanData = {
    findings,
    cachedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(data);
  const rawFindingsJson = JSON.stringify(findings);

  // 1. Write to Redis if available
  if (redisClient) {
    try {
      await redisClient.set(key, serialized, "EX", ttlSeconds);
    } catch (err) {
      console.warn("[SCAN_CACHE] Redis set failed:", err);
    }
  }

  // 2. Write to Prisma ScanCache table
  if (db && typeof db.scanCache?.upsert === "function") {
    try {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await db.scanCache.upsert({
        where: { cacheKey: key },
        create: {
          cacheKey: key,
          findingsJson: rawFindingsJson,
          expiresAt,
          hitCount: 0,
          lastAccessed: new Date(),
        },
        update: {
          findingsJson: rawFindingsJson,
          expiresAt,
          lastAccessed: new Date(),
        },
      });
    } catch (err) {
      console.warn("[SCAN_CACHE] Database set failed:", err);
    }
  }
}

/**
 * Explicitly invalidate a cache entry by key or delete all keys matching pattern in Redis.
 */
export async function invalidateScanCache(
  keyOrPattern?: string,
  deps: { redisClient?: typeof redis; db?: typeof prisma } = {},
): Promise<void> {
  const redisClient = deps.redisClient !== undefined ? deps.redisClient : redis;
  const db = deps.db !== undefined ? deps.db : prisma;

  if (redisClient) {
    try {
      if (keyOrPattern && !keyOrPattern.includes("*")) {
        await redisClient.del(keyOrPattern);
      } else {
        const pattern = keyOrPattern || `${SCAN_CACHE_PREFIX}*`;
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
          await redisClient.del(...keys);
        }
      }
    } catch (err) {
      console.warn("[SCAN_CACHE] Redis invalidation failed:", err);
    }
  }

  if (db && typeof db.scanCache?.deleteMany === "function") {
    try {
      if (keyOrPattern && !keyOrPattern.includes("*")) {
        await db.scanCache.deleteMany({ where: { cacheKey: keyOrPattern } });
      } else {
        await db.scanCache.deleteMany();
      }
    } catch (err) {
      console.warn("[SCAN_CACHE] Database invalidation failed:", err);
    }
  }
}
