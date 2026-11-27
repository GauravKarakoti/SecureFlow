import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  acquireCacheLock,
  releaseCacheLock,
  computeContentHash,
  computeEntryChecksum,
  getCacheEntry,
  setCacheEntry,
  reapOrphanedTempFiles,
  clearCache,
  type CacheEntry,
} from "./cache.js";
import type { FileScanResult } from "./scanner.js";

function makeScanResult(filePath: string, lineCount = 1): FileScanResult {
  return {
    file: filePath,
    language: "typescript",
    violations: Array.from({ length: lineCount }, (_, idx) => ({
      ruleId: "SF-TEST-001",
      ruleName: "Test Rule",
      severity: "medium",
      line: idx + 1,
      column: 1,
      snippet: "const x = 1;",
      message: "Test finding",
    })),
    linesScanned: 10,
  };
}

describe("CLI Scan Cache Atomic Write, Locking & Checksum Integrity (#2070)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-concurrency-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes checksummed cache entries atomically and leaves no leftover temp or lock files", () => {
    const content = "export const secret = 'hello';";
    const hash = computeContentHash(content);
    const result = makeScanResult("src/a.ts");

    setCacheEntry({
      filePath: "src/a.ts",
      content,
      result,
      cacheDir: tempDir,
    });

    const files = fs.readdirSync(tempDir);
    expect(files).toEqual([`${hash}.json`]);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tempDir, `${hash}.json`), "utf-8"),
    ) as CacheEntry;
    expect(raw.checksum).toBeDefined();
    expect(raw.checksum).toBe(computeEntryChecksum(raw));

    const fetched = getCacheEntry({ content, cacheDir: tempDir });
    expect(fetched).not.toBeNull();
    expect(fetched?.contentHash).toBe(hash);
    expect(fetched?.checksum).toBe(raw.checksum);
  });

  it("detects and discards cache entries with corrupted or tampered payload checksums", () => {
    const content = "export const api = 'test';";
    const hash = computeContentHash(content);
    const result = makeScanResult("src/corrupt.ts");

    setCacheEntry({
      filePath: "src/corrupt.ts",
      content,
      result,
      cacheDir: tempDir,
    });

    const cacheFile = path.join(tempDir, `${hash}.json`);
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as CacheEntry;
    // Tamper with payload without updating checksum (simulating bitrot or partial write)
    parsed.result.linesScanned = 9999;
    fs.writeFileSync(cacheFile, JSON.stringify(parsed, null, 2), "utf-8");

    const fetched = getCacheEntry({ content, cacheDir: tempDir });
    expect(fetched).toBeNull();
    // Corrupted cache entry should be automatically cleaned up
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("acquires and releases cooperative lockfiles exclusively", () => {
    const hash = "abc123def456";
    const acquired1 = acquireCacheLock(tempDir, hash, { timeoutMs: 200 });
    expect(acquired1).toBe(true);
    expect(fs.existsSync(path.join(tempDir, `.lock_${hash}`))).toBe(true);

    // Second acquisition while lock is active should time out
    const acquired2 = acquireCacheLock(tempDir, hash, { timeoutMs: 120, staleLockMs: 10000 });
    expect(acquired2).toBe(false);

    releaseCacheLock(tempDir, hash);
    expect(fs.existsSync(path.join(tempDir, `.lock_${hash}`))).toBe(false);

    // Subsequent acquisition succeeds after release
    const acquired3 = acquireCacheLock(tempDir, hash, { timeoutMs: 200 });
    expect(acquired3).toBe(true);
    releaseCacheLock(tempDir, hash);
  });

  it("automatically reclaims stale lockfiles exceeding staleLockMs", () => {
    const hash = "stalehash999";
    const lockPath = path.join(tempDir, `.lock_${hash}`);
    const oldTimestamp = Date.now() - 15000;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: oldTimestamp }), "utf-8");
    const oldSec = new Date(oldTimestamp);
    fs.utimesSync(lockPath, oldSec, oldSec);

    const acquired = acquireCacheLock(tempDir, hash, {
      timeoutMs: 300,
      staleLockMs: 5000,
    });
    expect(acquired).toBe(true);

    const lockMeta = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number };
    expect(lockMeta.pid).toBe(process.pid);
    releaseCacheLock(tempDir, hash);
  });

  it("reaps orphaned .tmp_* and stale .lock_* files during maintenance", () => {
    const oldTmp = path.join(tempDir, "hash1.json.tmp_123_1000_abcd");
    const freshTmp = path.join(tempDir, "hash2.json.tmp_124_2000_efgh");
    const oldLock = path.join(tempDir, ".lock_deadproc");

    fs.writeFileSync(oldTmp, "partial", "utf-8");
    fs.writeFileSync(freshTmp, "active", "utf-8");
    fs.writeFileSync(oldLock, "{}", "utf-8");

    const staleDate = new Date(Date.now() - 120_000);
    fs.utimesSync(oldTmp, staleDate, staleDate);
    fs.utimesSync(oldLock, staleDate, staleDate);

    const reaped = reapOrphanedTempFiles(tempDir, 60_000);
    expect(reaped).toBe(2);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(oldLock)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);

    const cleared = clearCache(tempDir);
    expect(cleared.cleared).toBe(true);
    expect(fs.existsSync(freshTmp)).toBe(false);
  });

  it("survives concurrent multi-process writes to the same cache key without corruption", async () => {
    const content = "export function concurrentTarget() { return 42; }";
    const hash = computeContentHash(content);
    const cacheTsPath = path.resolve(import.meta.dirname, "cache.ts");

    // Spawn 6 parallel worker processes writing the exact same cache key concurrently
    const workerScript = `
      import { setCacheEntry } from ${JSON.stringify(new URL("./cache.ts", import.meta.url).href)};
      const workerId = process.argv[2];
      const cacheDir = process.argv[3];
      const content = ${JSON.stringify(content)};
      for (let i = 0; i < 5; i++) {
        setCacheEntry({
          filePath: "src/concurrent.ts",
          content,
          cacheDir,
          result: {
            file: "src/concurrent.ts",
            language: "typescript",
            violations: [],
            linesScanned: Number(workerId) * 10 + i,
          },
        });
      }
    `;
    expect(fs.existsSync(cacheTsPath)).toBe(true);

    const workerScriptFile = path.join(os.tmpdir(), `sf-cache-worker-${Date.now()}.mts`);
    fs.writeFileSync(workerScriptFile, workerScript, "utf-8");
    const tsxCli = path.resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
    const workerCount = 5;

    try {
      await Promise.all(
        Array.from({ length: workerCount }, (_, idx) => {
          return new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [tsxCli, workerScriptFile, String(idx), tempDir],
              { stdio: "pipe" },
            );
            let stderr = "";
            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0) {
                reject(new Error(`Worker ${idx} exited with code ${code}: ${stderr}`));
              } else {
                resolve();
              }
            });
          });
        }),
      );
    } finally {
      fs.rmSync(workerScriptFile, { force: true });
    }

    const cacheFile = path.join(tempDir, `${hash}.json`);
    expect(fs.existsSync(cacheFile)).toBe(true);

    // Final file must be valid JSON with intact SHA-256 checksum
    const entry = getCacheEntry({ content, cacheDir: tempDir });
    expect(entry).not.toBeNull();
    expect(entry?.contentHash).toBe(hash);
    expect(entry?.checksum).toBe(computeEntryChecksum(entry!));

    // No orphaned lockfiles or temp files remain
    const remaining = fs.readdirSync(tempDir);
    expect(remaining).toEqual([`${hash}.json`]);
  }, 30_000);
});
