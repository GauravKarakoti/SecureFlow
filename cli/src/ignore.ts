import fs from "fs";
import path from "path";

export interface SecureFlowIgnoreConfig {
  ignoredPaths: string[];
  placeholders: string[];
}

/**
 * Normalizes a file path for consistent matching against ignore patterns:
 * converts backslashes to forward slashes, removes leading `./` or `/`.
 */
export function normalizeScanPath(filename: string): string {
  return filename
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * Parses the raw text of a `.secureflowignore` file into structured configuration.
 *
 * Supports comments (`#`), whitespace trimming, and optional section headers:
 * - `[paths]` or `[files]`: file paths and glob patterns to ignore
 * - `[placeholders]` or `[mocks]`: test credential values/patterns to suppress
 */
export function parseSecureFlowIgnore(content: string): SecureFlowIgnoreConfig {
  const ignoredPaths: string[] = [];
  const placeholders: string[] = [];
  let currentSection: "paths" | "placeholders" = "paths";

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (lower === "[placeholders]" || lower === "[mocks]") {
      currentSection = "placeholders";
      continue;
    }

    if (lower === "[paths]" || lower === "[files]") {
      currentSection = "paths";
      continue;
    }

    if (currentSection === "placeholders") {
      placeholders.push(trimmed);
    } else {
      ignoredPaths.push(trimmed);
    }
  }

  return { ignoredPaths, placeholders };
}

/**
 * Compiles an array of glob strings into RegExp patterns for path matching.
 */
export function compileIgnorePatterns(patterns: string[]): RegExp[] {
  return patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"))
    .map((p) => {
      let pattern = p.replace(/\\/g, "/");
      const hasLeadingSlash = pattern.startsWith("/");
      const cleanPattern = hasLeadingSlash ? pattern.slice(1) : pattern;

      let glob = cleanPattern;
      if (glob.endsWith("/")) {
        glob += "**";
      }

      const patternWithoutTrailingSlash = cleanPattern.endsWith("/")
        ? cleanPattern.slice(0, -1)
        : cleanPattern;
      const isRootRelative = hasLeadingSlash || patternWithoutTrailingSlash.includes("/");

      // Escape regex special characters except *, ?
      let regexStr = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");

      // Handle question mark wildcard (single non-slash char)
      regexStr = regexStr.replace(/\?/g, "[^/]");

      // Handle glob double asterisks (arbitrary directories)
      regexStr = regexStr.replace(/\/\*\*\//g, "/(?:.*/)?");
      regexStr = regexStr.replace(/\*\*\//g, "(?:.*/)?");
      regexStr = regexStr.replace(/\/\*\*/g, "(?:/.*)?");
      regexStr = regexStr.replace(/\*\*/g, ".*");

      // Handle glob single asterisk (within a single directory segment)
      regexStr = regexStr.replace(/(?<!\.)\*(?!\.)/g, "[^/]*");

      if (isRootRelative) {
        return new RegExp(`^${regexStr}$`, "i");
      } else {
        return new RegExp(`(^|/)${regexStr}$`, "i");
      }
    });
}

/**
 * Checks whether a given file path matches any compiled ignore regular expression.
 */
export function shouldIgnorePath(filename: string, customIgnores: RegExp[] = []): boolean {
  if (!filename || !customIgnores || customIgnores.length === 0) {
    return false;
  }

  const normalized = normalizeScanPath(filename);
  return customIgnores.some((pattern) => pattern.test(normalized));
}

/**
 * Searches for and loads `.secureflowignore` from the specified path or directory root.
 * Returns the parsed configuration and compiled regex patterns, or `null` if the file doesn't exist.
 */
export function loadSecureFlowIgnore(
  customFilePath?: string,
  rootDir: string = process.cwd(),
): { config: SecureFlowIgnoreConfig; compiledPatterns: RegExp[] } | null {
  const targetPath = customFilePath
    ? path.resolve(rootDir, customFilePath)
    : path.join(rootDir, ".secureflowignore");

  if (!fs.existsSync(targetPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(targetPath, "utf-8");
    const config = parseSecureFlowIgnore(content);
    const compiledPatterns = compileIgnorePatterns(config.ignoredPaths);
    return { config, compiledPatterns };
  } catch (err) {
    console.warn(
      `⚠️  [SecureFlow] Failed to read ignore file at ${targetPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
