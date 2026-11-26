import fs from "fs";
import path from "path";
import {
  scanFile,
  type FileScanResult,
  type Violation,
  type Severity,
  compileIgnorePatterns,
  DEFAULT_IGNORE_PATTERNS,
  shouldScanFile,
  type FailOnSeverity,
} from "./scanner.js";
import { discoverWorkspaceFiles } from "./workspace.js";
import { shouldIgnorePath } from "./ignore.js";
import type { CompiledCustomRule } from "./custom-rules.js";
import { colors } from "./lib/tui.js";

/**
 * Standard build, dependency, and temporary directory names to exclude during workspace watching.
 */
export const WATCH_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".secureflow",
  "out",
  ".cache",
]);

/**
 * Fast heuristic to determine if a file is binary.
 */
export function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const readBuf = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, readBuf, 0, 8000, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (readBuf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Interface representing a normalized, tracked finding in watch mode.
 */
export interface TrackedFinding {
  filePath: string;
  rule: string;
  severity: Severity;
  line: number;
  column?: number;
  snippet: string;
  reason: string;
  fingerprint: string;
}

/**
 * Result of comparing previous findings with newly analyzed findings for a file.
 */
export interface FindingDiff {
  filePath: string;
  resolved: TrackedFinding[];
  newFindings: TrackedFinding[];
  existing: TrackedFinding[];
  current: TrackedFinding[];
}

/**
 * Computes a deterministic fingerprint for a finding within a file to track persistence across line shifts.
 */
export function createFindingFingerprint(
  filePath: string,
  finding: { rule?: string; snippet?: string; text?: string; reason?: string },
): string {
  const rule = finding.rule || "rule";
  const snippet = (finding.snippet || finding.text || "").trim();
  return `${filePath}::${rule}::${snippet}`;
}

/**
 * Compares prior tracked findings against current findings for a specific file.
 * Accurately detects:
 * - Findings that were fixed/disappeared (resolved)
 * - Findings that were newly introduced (newFindings)
 * - Findings that persisted even if lines shifted slightly (existing)
 */
export function diffFindings(
  filePath: string,
  previous: TrackedFinding[],
  current: TrackedFinding[],
): FindingDiff {
  const resolved: TrackedFinding[] = [];
  const existing: TrackedFinding[] = [];
  const currentPool = [...current];

  for (const prev of previous) {
    const prevKey = prev.fingerprint;

    // 1. First priority: exact match on line and fingerprint
    const exactIdx = currentPool.findIndex(
      (c) => c.line === prev.line && c.fingerprint === prevKey,
    );
    if (exactIdx !== -1) {
      existing.push(currentPool[exactIdx]!);
      currentPool.splice(exactIdx, 1);
      continue;
    }

    // 2. Second priority: fingerprint match on shifted line (same rule + snippet)
    const fpIdx = currentPool.findIndex((c) => c.fingerprint === prevKey);
    if (fpIdx !== -1) {
      existing.push(currentPool[fpIdx]!);
      currentPool.splice(fpIdx, 1);
      continue;
    }

    // 3. Finding is no longer present in current file -> resolved!
    resolved.push(prev);
  }

  // Any remaining findings in currentPool are brand new
  const newFindings = currentPool;

  return {
    filePath,
    resolved,
    newFindings,
    existing,
    current,
  };
}

/**
 * Checks whether a given relative path belongs to an ignored directory, build output, or ignore rule.
 */
export function isIgnoredWatchPath(relPath: string, customIgnores: RegExp[] = []): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return false;

  const segments = normalized.split("/");
  for (const seg of segments) {
    if (WATCH_EXCLUDED_DIRS.has(seg)) {
      return true;
    }
  }

  const basename = segments[segments.length - 1] || "";
  // Ignore temporary files, editor backups, lock files, and hidden scratch files
  if (
    basename.endsWith("~") ||
    basename.endsWith(".tmp") ||
    basename.endsWith(".swp") ||
    basename.startsWith(".#") ||
    basename === ".DS_Store" ||
    basename === "thumbs.db"
  ) {
    return true;
  }

  // Check custom ignore globs / .secureflowignore
  if (customIgnores.length > 0 && shouldIgnorePath(normalized, customIgnores)) {
    return true;
  }

  return false;
}

export interface FileWatcher {
  close(): void | Promise<void>;
}

export type WatcherCallback = (eventType: "change" | "rename", filename: string) => void;

export type WatcherFactory = (
  dir: string,
  options: { recursive?: boolean },
  callback: WatcherCallback,
) => FileWatcher;

/**
 * Default filesystem watcher factory using Node.js fs.watch with recursive watching.
 */
export const defaultWatcherFactory: WatcherFactory = (
  dir: string,
  options: { recursive?: boolean },
  callback: WatcherCallback,
): FileWatcher => {
  const watcher = fs.watch(dir, { recursive: options.recursive ?? true }, (eventType, filename) => {
    if (filename) {
      callback(eventType as any, filename.toString());
    }
  });

  return {
    close: () => {
      try {
        watcher.close();
      } catch {
        // ignore watcher closing errors
      }
    },
  };
};

/**
 * In-memory test watcher fake to simulate file events and testing debounce behavior without disk I/O.
 */
export class FakeFileWatcher implements FileWatcher {
  public closed = false;
  private callbacks: WatcherCallback[] = [];

  public addCallback(cb: WatcherCallback): void {
    this.callbacks.push(cb);
  }

  public emit(eventType: "change" | "rename", filename: string): void {
    if (this.closed) return;
    for (const cb of this.callbacks) {
      cb(eventType, filename);
    }
  }

  public close(): void {
    this.closed = true;
    this.callbacks = [];
  }
}

export interface WatchModeOptions {
  targetDir?: string;
  workspaceRoot?: string;
  debounceMs?: number;
  customIgnores?: RegExp[];
  customRules?: CompiledCustomRule[];
  severityFilter?: Set<Severity> | null;
  failOnThreshold?: FailOnSeverity | null;
  ignoreSuppressions?: boolean;
  initialScan?: boolean;
  watcherFactory?: WatcherFactory;
  registerSignalHandlers?: boolean;
  exitOnSignal?: boolean;
  logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  onScanStart?: (filePath: string) => void;
  onScanComplete?: (filePath: string, diff: FindingDiff) => void;
  onResolvedFinding?: (filePath: string, finding: TrackedFinding) => void;
  onNewFinding?: (filePath: string, finding: TrackedFinding) => void;
  onExit?: () => void;
}

export interface WatchSession {
  stop(): Promise<void>;
  rescanFile(relPath: string): Promise<FindingDiff | null>;
  getTrackedFindings(filePath?: string): TrackedFinding[];
  isWatching(): boolean;
  getTotalActiveFindings(): number;
}

/**
 * Initializes and starts real-time workspace watch mode.
 */
export async function startWatchMode(options: WatchModeOptions = {}): Promise<WatchSession> {
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
  const targetDir = options.targetDir
    ? path.resolve(workspaceRoot, options.targetDir)
    : workspaceRoot;
  const debounceMs = options.debounceMs ?? 200;
  const customIgnores =
    options.customIgnores ?? compileIgnorePatterns([...DEFAULT_IGNORE_PATTERNS]);
  const customRules = options.customRules ?? [];
  const watcherFactory = options.watcherFactory ?? defaultWatcherFactory;
  const logger = options.logger ?? console;

  let isRunning = true;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const findingsStore = new Map<string, TrackedFinding[]>();
  let activeWatcher: FileWatcher | null = null;

  // Converts a Violation to a TrackedFinding
  const toTrackedFinding = (relPath: string, v: Violation): TrackedFinding => {
    const snippet = (v as any).snippet || v.text || "";
    const rule = (v as any).rule || v.ruleId || "secret-logging";
    const severity = v.severity || "HIGH";
    return {
      filePath: relPath,
      rule,
      severity,
      line: v.line,
      column: (v as any).column,
      snippet,
      reason: v.reason,
      fingerprint: createFindingFingerprint(relPath, {
        rule,
        snippet,
        reason: v.reason,
      }),
    };
  };

  /**
   * Rescans a single target file, computes differences vs prior scan, and logs results.
   */
  const rescanFile = async (rawRelPath: string): Promise<FindingDiff | null> => {
    if (!isRunning) return null;

    const relPath = rawRelPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (isIgnoredWatchPath(relPath, customIgnores)) {
      return null;
    }

    const fullPath = path.resolve(workspaceRoot, relPath);
    options.onScanStart?.(relPath);

    // 1. Handle deleted or unreadable file
    if (!fs.existsSync(fullPath)) {
      const prev = findingsStore.get(relPath) || [];
      if (prev.length > 0) {
        findingsStore.delete(relPath);
        const diff = diffFindings(relPath, prev, []);
        for (const resolved of diff.resolved) {
          options.onResolvedFinding?.(relPath, resolved);
          logger.log(
            `${colors.green("✨ Resolved:")} [${colors.bold(resolved.severity)}] ${resolved.rule} in ${resolved.filePath}:${resolved.line}`,
          );
        }
        logger.log(
          `${colors.green("✅")} File deleted or moved. ${diff.resolved.length} previous finding(s) cleared for ${relPath}.`,
        );
        options.onScanComplete?.(relPath, diff);
        return diff;
      }
      return null;
    }

    // 2. Ignore directory changes (directories are traversed via recursive watcher)
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }

    // 3. Check file suitability
    if (!shouldScanFile(relPath, undefined, customIgnores)) {
      return null;
    }
    if (isBinaryFile(fullPath)) {
      return null;
    }

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }

    // 4. Scan file
    const scanResult: FileScanResult = scanFile(relPath, content, customIgnores, {
      ...(options.ignoreSuppressions ? { ignoreSuppressions: options.ignoreSuppressions } : {}),
      ...(customRules.length > 0 ? { customRules } : {}),
    });

    let violations = scanResult.violations;
    if (options.severityFilter) {
      violations = violations.filter((v) => options.severityFilter!.has(v.severity ?? "HIGH"));
    }

    const currentFindings = violations.map((v) => toTrackedFinding(relPath, v));
    const prevFindings = findingsStore.get(relPath) || [];
    const diff = diffFindings(relPath, prevFindings, currentFindings);

    // 5. Update store
    if (currentFindings.length > 0) {
      findingsStore.set(relPath, currentFindings);
    } else {
      findingsStore.delete(relPath);
    }

    // 6. Report resolved findings
    for (const resolved of diff.resolved) {
      options.onResolvedFinding?.(relPath, resolved);
      logger.log(
        `${colors.green("✨ Resolved:")} [${colors.bold(resolved.severity)}] ${resolved.rule} in ${resolved.filePath}:${resolved.line}\n   ${colors.dim(`Fixed: ${resolved.snippet}`)}`,
      );
    }

    // 7. Report newly introduced findings
    for (const newFinding of diff.newFindings) {
      options.onNewFinding?.(relPath, newFinding);
      logger.log(
        `${colors.red("⚠️  New finding:")} [${colors.bold(newFinding.severity)}] ${newFinding.rule} in ${newFinding.filePath}:${newFinding.line}\n   ${colors.bold(newFinding.snippet)} ${colors.dim(`(${newFinding.reason})`)}`,
      );
    }

    // 8. Summary status
    if (diff.resolved.length > 0 && currentFindings.length === 0) {
      logger.log(`${colors.green("✅ All findings resolved in")} ${colors.bold(relPath)}!`);
    } else if (
      diff.resolved.length === 0 &&
      diff.newFindings.length === 0 &&
      currentFindings.length === 0
    ) {
      logger.log(`${colors.green("✅")} ${relPath}: Clean (no security violations detected).`);
    } else if (
      diff.newFindings.length === 0 &&
      diff.resolved.length === 0 &&
      currentFindings.length > 0
    ) {
      logger.log(
        `${colors.yellow("ℹ️ ")} ${relPath}: ${currentFindings.length} active finding(s) unchanged.`,
      );
    }

    options.onScanComplete?.(relPath, diff);
    return diff;
  };

  /**
   * Schedules a debounced rescan for a changed file.
   */
  const scheduleRescan = (filename: string): void => {
    if (!isRunning) return;

    // Normalize path relative to workspaceRoot
    let relPath = filename.replace(/\\/g, "/");
    if (path.isAbsolute(relPath)) {
      relPath = path.relative(workspaceRoot, relPath).replace(/\\/g, "/");
    } else if (targetDir !== workspaceRoot) {
      const relFromTarget = path.relative(workspaceRoot, path.join(targetDir, relPath));
      relPath = relFromTarget.replace(/\\/g, "/");
    }

    if (isIgnoredWatchPath(relPath, customIgnores)) {
      return;
    }

    // Cancel existing debounce timer for this file
    const existingTimer = debounceTimers.get(relPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      debounceTimers.delete(relPath);
      try {
        await rescanFile(relPath);
      } catch (err) {
        logger.error(`❌ [SecureFlow Watch] Error rescanning ${relPath}: ${String(err)}`);
      }
    }, debounceMs);

    debounceTimers.set(relPath, timer);
  };

  // 1. Initial scan if requested (default true)
  if (options.initialScan !== false) {
    logger.log(`${colors.cyan("⏳")} Scanning workspace files before starting watch mode...`);
    try {
      const initialFiles = discoverWorkspaceFiles(targetDir, {
        workspaceRoot,
        customIgnores,
      });

      let initialFindingCount = 0;
      for (const relPath of initialFiles) {
        if (isIgnoredWatchPath(relPath, customIgnores)) continue;
        const fullPath = path.resolve(workspaceRoot, relPath);
        if (!fs.existsSync(fullPath) || isBinaryFile(fullPath)) continue;

        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const res = scanFile(relPath, content, customIgnores, {
            ...(options.ignoreSuppressions
              ? { ignoreSuppressions: options.ignoreSuppressions }
              : {}),
            ...(customRules.length > 0 ? { customRules } : {}),
          });

          let violations = res.violations;
          if (options.severityFilter) {
            violations = violations.filter((v) =>
              options.severityFilter!.has(v.severity ?? "HIGH"),
            );
          }

          if (violations.length > 0) {
            const tracked = violations.map((v) => toTrackedFinding(relPath, v));
            findingsStore.set(relPath, tracked);
            initialFindingCount += tracked.length;
          }
        } catch {
          // ignore unreadable files during initial scan
        }
      }

      const fileCountWithFindings = findingsStore.size;
      if (initialFindingCount > 0) {
        logger.log(
          `${colors.yellow("⚠️ ")} Found ${colors.bold(String(initialFindingCount))} active finding(s) across ${colors.bold(String(fileCountWithFindings))} file(s).`,
        );
      } else {
        logger.log(`${colors.green("✨")} Workspace is clean (0 active findings).`);
      }
    } catch (err) {
      logger.warn(`⚠️ [SecureFlow Watch] Initial scan encountered error: ${String(err)}`);
    }
  }

  // 2. Start watcher
  const watchPathDisplay = path.relative(process.cwd(), targetDir) || ".";
  logger.log(
    `${colors.cyan("👀 [SecureFlow]")} Watching for file changes in ${colors.bold(watchPathDisplay)}... (Press Ctrl+C to exit)`,
  );

  activeWatcher = watcherFactory(targetDir, { recursive: true }, (_eventType, filename) => {
    if (filename) {
      scheduleRescan(filename);
    }
  });

  // 3. Graceful termination and signal handling
  const cleanStop = async (): Promise<void> => {
    if (!isRunning) return;
    isRunning = false;

    // Clear all pending debounce timers
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();

    // Close active filesystem watcher
    if (activeWatcher) {
      try {
        await activeWatcher.close();
      } catch {
        // ignore
      }
      activeWatcher = null;
    }

    if (options.onExit) {
      options.onExit();
    } else {
      logger.log(`\n${colors.cyan("👋 [SecureFlow]")} Watch mode stopped.`);
    }
  };

  const sigintHandler = () => {
    cleanStop().finally(() => {
      if (options.exitOnSignal !== false) {
        process.exit(0);
      }
    });
  };

  const sigtermHandler = () => {
    cleanStop().finally(() => {
      if (options.exitOnSignal !== false) {
        process.exit(0);
      }
    });
  };

  if (options.registerSignalHandlers !== false) {
    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);
  }

  return {
    stop: async () => {
      if (options.registerSignalHandlers !== false) {
        process.off("SIGINT", sigintHandler);
        process.off("SIGTERM", sigtermHandler);
      }
      await cleanStop();
    },
    rescanFile,
    getTrackedFindings: (filePath?: string) => {
      if (filePath) {
        const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
        return findingsStore.get(norm) || [];
      }
      const all: TrackedFinding[] = [];
      for (const list of findingsStore.values()) {
        all.push(...list);
      }
      return all;
    },
    isWatching: () => isRunning,
    getTotalActiveFindings: () => {
      let count = 0;
      for (const list of findingsStore.values()) {
        count += list.length;
      }
      return count;
    },
  };
}

/**
 * Runs the watch mode CLI workflow until interrupted by SIGINT / SIGTERM.
 */
export async function runWatchMode(options: WatchModeOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    let resolved = false;

    startWatchMode({
      ...options,
      exitOnSignal: false,
      onExit: () => {
        if (!resolved) {
          resolved = true;
          resolve(0);
        }
      },
    }).catch((err) => {
      if (options.logger) {
        options.logger.error(`❌ [SecureFlow Watch] Failed to start watch mode: ${String(err)}`);
      } else {
        console.error(`❌ [SecureFlow Watch] Failed to start watch mode: ${String(err)}`);
      }
      if (!resolved) {
        resolved = true;
        resolve(1);
      }
    });
  });
}
