import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
