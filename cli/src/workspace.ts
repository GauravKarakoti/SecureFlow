import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { shouldIgnorePath } from "./ignore.js";

export interface WorkspacePaths {
  cliDir: string;
  cliPackageJsonPath: string;
  rootDir: string;
  rootPackageJsonPath: string;
  rootPackageLockPath: string;
  nestedLockPath: string;
}

// __dirname does not exist in the ESM build this package ships ("type":
// "module"), so derive the default from import.meta.url instead.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function getWorkspacePaths(baseDir: string = moduleDir): WorkspacePaths {
  const cliDir = path.resolve(baseDir, "..");
  const rootDir = path.resolve(cliDir, "..");

  return {
    cliDir,
    cliPackageJsonPath: path.join(cliDir, "package.json"),
    rootDir,
    rootPackageJsonPath: path.join(rootDir, "package.json"),
    rootPackageLockPath: path.join(rootDir, "package-lock.json"),
    nestedLockPath: path.join(cliDir, "package-lock.json"),
  };
}

export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export class PathTraversalError extends Error {
  public readonly code = "PATH_TRAVERSAL_DETECTED";
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

/**
 * Sandboxes and canonicalizes a target relative or absolute path against a workspace root (#1752).
 * Resolves symlinks via fs.realpathSync and rejects any paths that escape the workspace boundary.
 */
export function sandboxWorkspacePath(
  targetPath: string,
  workspaceRoot: string = process.cwd(),
): string {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    throw new PathTraversalError("Target path must be a non-empty string");
  }

  // Canonicalize workspace root
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(path.resolve(workspaceRoot));
  } catch {
    canonicalRoot = path.resolve(workspaceRoot);
  }

  const resolvedTarget = path.resolve(canonicalRoot, targetPath);

  // If the target exists, resolve realpath to detect symlink escapes
  let canonicalTarget: string;
  try {
    canonicalTarget = fs.realpathSync(resolvedTarget);
  } catch {
    // If target doesn't exist yet, check its closest existing ancestor
    let current = path.dirname(resolvedTarget);
    let resolvedAncestor = "";
    while (current !== path.dirname(current)) {
      try {
        resolvedAncestor = fs.realpathSync(current);
        break;
      } catch {
        current = path.dirname(current);
      }
    }

    if (resolvedAncestor) {
      const relative = path.relative(canonicalRoot, resolvedAncestor);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new PathTraversalError(
          `Path traversal forbidden: ancestor symlink "${targetPath}" escapes workspace boundary "${canonicalRoot}"`,
        );
      }
    }

    canonicalTarget = resolvedTarget;
  }

  // Enforce boundary check: relative path must not start with '..'
  const relativeFromRoot = path.relative(canonicalRoot, canonicalTarget);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new PathTraversalError(
      `Path traversal forbidden: target path "${targetPath}" escapes workspace boundary "${canonicalRoot}"`,
    );
  }

  return canonicalTarget;
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB
export const DEFAULT_DIR_SCAN_EXCLUDES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".secureflow",
]);

/**
 * Fast heuristic to determine if a file is binary.
 * Reads up to the first 8000 bytes and checks for null bytes (\0).
 */
export function isBinaryFile(filePath: string, buffer?: Buffer): boolean {
  try {
    let buf = buffer;
    if (!buf) {
      const fd = fs.openSync(filePath, "r");
      const readBuf = Buffer.alloc(8000);
      const bytesRead = fs.readSync(fd, readBuf, 0, 8000, 0);
      fs.closeSync(fd);
      buf = readBuf.subarray(0, bytesRead);
    }
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface DiscoverWorkspaceFilesOptions {
  workspaceRoot?: string | undefined;
  customIgnores?: RegExp[] | undefined;
  maxFileSizeBytes?: number | undefined;
  skipBinary?: boolean | undefined;
  maxDepth?: number | undefined;
}

/**
 * Recursively discovers files in targetDir with workspace sandboxing, symlink escape protection,
 * cycle avoidance, .secureflowignore matching, and binary/oversized file exclusion.
 */
export function discoverWorkspaceFiles(
  targetDir: string,
  options: DiscoverWorkspaceFilesOptions = {},
): string[] {
  const root = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
  const maxSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const skipBinary = options.skipBinary ?? true;
  const maxDepth = options.maxDepth ?? 30;
  const customIgnores = options.customIgnores ?? [];

  let sandboxedTarget: string;
  try {
    sandboxedTarget = sandboxWorkspacePath(targetDir, root);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      console.warn(`⚠️  [SecureFlow] Target directory rejected: ${err.message}`);
      return [];
    }
    throw err;
  }

  if (!fs.existsSync(sandboxedTarget)) {
    return [];
  }

  const targetStat = fs.statSync(sandboxedTarget);
  if (!targetStat.isDirectory()) {
    if (targetStat.size > maxSizeBytes) return [];
    if (skipBinary && isBinaryFile(sandboxedTarget)) return [];
    const rel = path.relative(root, sandboxedTarget).replace(/\\/g, "/");
    return [rel];
  }

  const results: string[] = [];
  const visitedRealPaths = new Set<string>();

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    let realCurrent: string;
    try {
      realCurrent = fs.realpathSync(currentDir);
    } catch {
      return;
    }

    if (visitedRealPaths.has(realCurrent)) {
      return;
    }
    visitedRealPaths.add(realCurrent);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryName = entry.name;
      if (DEFAULT_DIR_SCAN_EXCLUDES.has(entryName)) {
        continue;
      }

      const fullEntryPath = path.join(currentDir, entryName);

      let sandboxedEntry: string;
      try {
        sandboxedEntry = sandboxWorkspacePath(fullEntryPath, root);
      } catch {
        continue; // Skip symlinks escaping the workspace boundary
      }

      const relativePath = path.relative(root, sandboxedEntry).replace(/\\/g, "/");

      if (shouldIgnorePath(relativePath, customIgnores)) {
        continue;
      }

      try {
        const itemStat = fs.statSync(sandboxedEntry);
        if (itemStat.isDirectory()) {
          walk(sandboxedEntry, depth + 1);
        } else if (itemStat.isFile()) {
          if (itemStat.size > maxSizeBytes) {
            continue;
          }
          if (skipBinary && isBinaryFile(sandboxedEntry)) {
            continue;
          }
          results.push(relativePath);
        }
      } catch {
        // ignore unreadable files
      }
    }
  }

  walk(sandboxedTarget, 0);
  return results.sort();
}
