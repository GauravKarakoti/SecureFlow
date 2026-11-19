/**
 * Which files the scanner is allowed to look at (#704).
 *
 * This decides what gets read, so it fails in a direction that matters: a file
 * wrongly ignored is a file the AI never sees, and the pull request still
 * receives a `PASS` and a "Scan completed successfully" comment. There is no
 * error, no warning, and nothing in the report that says the file was skipped.
 *
 * The rules used to be tested with `String.prototype.includes` — as bare
 * substrings of the whole path, with no directory or filename boundary:
 *
 *     if (IGNORED_PATHS.some(path => lower.includes(path))) return true;
 *     const ignorePatterns = ['package.json', 'components.json', ...];
 *     if (ignorePatterns.some(pattern => lower.includes(pattern))) return true;
 *
 * `'build/'` is a substring of `prebuild/`, `postbuild/`, `gradle-build/` and
 * `ci-build/`. `'dist/'` is a substring of `redist/` and `cdndist/`. And the
 * second rule was not anchored to a separator at all, so `'package.json'`
 * matched `tools/package.json.generator.ts`. Every one of those files was
 * dropped from the scan silently.
 *
 * The replacement matches on **path segments** for directory rules and on the
 * **basename** for filename rules, which is what the original lists plainly
 * meant. Every file that was supposed to be ignored still is; only the
 * accidental collateral changes.
 *
 * Extension rules keep using `endsWith`, which was already boundary-correct.
 *
 * Pure and free of `fs`, `process` and the Groq client, so the matching can be
 * tested directly — which is why the near-miss cases below now have coverage
 * where the original had only true-positives.
 */

/**
 * Non-executable text, assets, metadata and dependency manifests.
 *
 * Matched with `endsWith` against the lower-cased path. `lock.json` catches
 * `package-lock.json`, `tsconfig.json` catches `apps/web/tsconfig.json`.
 */
export const IGNORED_EXTENSIONS = [
  "lock.json",
  ".lock",
  "lock.yaml",
  ".csv",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".md",
  "tsconfig.json",
] as const;

/**
 * Generated and vendored directories.
 *
 * Each entry is a run of one or more path segments. A rule matches when that
 * run appears as consecutive *directory* segments of the path — so
 * `prisma/migrations/` matches both `prisma/migrations/x.sql` and
 * `apps/api/prisma/migrations/x.sql`, but not `myprisma/migrations/x.sql`.
 */
export const IGNORED_DIRECTORIES = [
  "dist/",
  "build/",
  ".next/",
  "node_modules/",
  "prisma/migrations/",
] as const;

/**
 * Configuration files whose contents are structure rather than logic.
 *
 * Matched on the basename, so `package.json` is ignored and
 * `tools/package.json.generator.ts` — which is ordinary TypeScript that can
 * hold a credential like any other file — is not.
 */
export const IGNORED_BASENAMES = [
  "package.json",
  "components.json",
  "prisma.config.ts",
  ".gitignore",
] as const;

/**
 * Put a path into the one form the rules are written against.
 *
 * Windows separators become `/`, a leading `./` or `/` is dropped, and the
 * whole thing is lower-cased. GitHub sends POSIX-style relative paths, but the
 * CLI hook reads whatever git hands it, so normalising costs one pass and
 * removes a class of near-miss.
 */
export function normalizeScanPath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/** The path's segments, with empty ones (from `a//b`) dropped. */
export function pathSegments(normalizedPath: string): string[] {
  return normalizedPath.split("/").filter((segment) => segment.length > 0);
}

/** The filename, without its directories. */
export function basenameOf(normalizedPath: string): string {
  const segments = pathSegments(normalizedPath);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

/**
 * Whether `normalizedPath` lives under the directory run `rule` describes.
 *
 * Only the directory portion is considered. A *file* called `build` is a file,
 * not a build directory, and should be scanned like any other.
 */
export function isUnderIgnoredDirectory(normalizedPath: string, rule: string): boolean {
  const ruleSegments = pathSegments(normalizeScanPath(rule));
  if (ruleSegments.length === 0) return false;

  const segments = pathSegments(normalizedPath);
  // The last segment is the filename; a directory rule can only match above it.
  const directories = segments.slice(0, -1);

  for (let i = 0; i + ruleSegments.length <= directories.length; i++) {
    if (ruleSegments.every((segment, offset) => directories[i + offset] === segment)) {
      return true;
    }
  }

  return false;
}

/** Whether the path ends with one of the ignored extensions. */
export function hasIgnoredExtension(normalizedPath: string): boolean {
  return IGNORED_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
}

/** Whether the path's basename is one of the ignored configuration files. */
export function hasIgnoredBasename(normalizedPath: string): boolean {
  const basename = basenameOf(normalizedPath);
  return IGNORED_BASENAMES.some((name) => basename === name);
}

/** Why a file was skipped, for the log line the scanner prints. */
export type IgnoreReason = "directory" | "extension" | "config-file" | "custom" | null;

/**
 * Decide whether `filename` should be skipped, and say why.
 *
 * `null` means scan it. The reason is returned rather than a bare boolean so
 * the scanner's log line can name the rule that fired, which is the difference
 * between diagnosing a false skip in a minute and never noticing it.
 *
 * Custom `.secureflowignore` patterns are still applied as the compiled regular
 * expressions `compileIgnorePatterns` produces, against the normalised path.
 * That behaviour is deliberately unchanged: those patterns are written by the
 * repository's own maintainers, and they are glob-anchored already.
 */
export function ignoreReasonFor(filename: string, customIgnores: RegExp[] = []): IgnoreReason {
  if (typeof filename !== "string" || filename.trim() === "") return null;

  const normalized = normalizeScanPath(filename);

  if (IGNORED_DIRECTORIES.some((rule) => isUnderIgnoredDirectory(normalized, rule))) {
    return "directory";
  }

  if (hasIgnoredExtension(normalized)) {
    return "extension";
  }

  // `.env.example` is deliberately NOT ignored here: the scanner has a dedicated
  // context hint and false-positive filter for template files, and a real key
  // committed to one is still a real key.
  if (hasIgnoredBasename(normalized)) {
    return "config-file";
  }

  const forCustom = filename.replace(/\\/g, "/");
  if (customIgnores.some((pattern) => pattern.test(forCustom))) {
    return "custom";
  }

  return null;
}

/** Whether the scanner should skip `filename`. */
export function shouldIgnorePath(filename: string, customIgnores: RegExp[] = []): boolean {
  return ignoreReasonFor(filename, customIgnores) !== null;
}

export interface IgnoreRuleEntry {
  pattern: string;
  reason?: string;
  expires?: string;
  rawExpires?: string;
}

export interface ExpiredIgnoreRule {
  pattern: string;
  expires: string;
  reason?: string;
}

export interface SecureFlowIgnoreConfig {
  ignoredPaths: string[];
  placeholders: string[];
  rules?: IgnoreRuleEntry[];
  expiredRules?: ExpiredIgnoreRule[];
  warnings?: string[];
}

export interface ParseSecureFlowIgnoreOptions {
  now?: Date;
}

/**
 * Parse an ISO date or calendar date in YYYY-MM-DD or standard parseable format.
 * Returns null if the date is invalid (e.g. 2026-02-31, 2026-13-45, or "tomorrow").
 * When YYYY-MM-DD is supplied, it is evaluated through the end of that day in UTC (23:59:59.999 UTC).
 */
export function parseExpiryDateUtc(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

    // Check year/month/day roundtrip to prevent month-end overflow (e.g. Feb 31 -> Mar 3)
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }

    return date;
  }

  // Fallback for full ISO timestamps or valid date strings
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/**
 * Parses an individual ignore rule line, extracting the glob pattern and optional reason and expiry date.
 */
export function parseIgnoreRuleLine(rawLine: string): {
  pattern: string;
  reason?: string;
  expires?: string;
} {
  const line = rawLine.trim();

  // 1. JSON line support: {"pattern": "...", "reason": "...", "expires": "..."}
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const parsed = JSON.parse(line);
      const pattern = parsed.pattern ?? parsed.path ?? parsed.glob;
      if (typeof pattern === "string" && pattern.trim()) {
        const reason =
          typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason.trim()
            : undefined;
        const rawExpiry = parsed.expires ?? parsed.expiry;
        const expires =
          typeof rawExpiry === "string" && rawExpiry.trim() ? rawExpiry.trim() : undefined;
        return { pattern: pattern.trim(), reason, expires };
      }
    } catch {
      // Fall through to text parsing
    }
  }

  let expires: string | undefined;
  let reason: string | undefined;
  let remaining = line;

  // 2. Bracket attributes: [expires=YYYY-MM-DD] / [expires: YYYY-MM-DD]
  const expiresMatch = remaining.match(/\[expires[:=]\s*([^\]]+)\]/i);
  if (expiresMatch) {
    expires = expiresMatch[1].trim();
    remaining = remaining.replace(expiresMatch[0], " ").trim();
  }

  // Bracket reason: [reason=...] / [reason: ...]
  const reasonMatch = remaining.match(/\[reason[:=]\s*([^\]]+)\]/i);
  if (reasonMatch) {
    reason = reasonMatch[1].trim();
    remaining = remaining.replace(reasonMatch[0], " ").trim();
  }

  // 3. Trailing hash comment: pattern # reason or pattern # expires=... reason
  const commentIdx = remaining.search(/\s+#/);
  if (commentIdx !== -1) {
    const patternPart = remaining.slice(0, commentIdx).trim();
    const commentPart = remaining
      .slice(commentIdx)
      .replace(/^\s+#\s*/, "")
      .trim();

    if (!reason && commentPart) {
      const commentExpires = commentPart.match(/expires[:=]\s*(\S+)/i);
      if (commentExpires && !expires) {
        expires = commentExpires[1].trim();
      }
      const commentReason = commentPart.match(/reason[:=]\s*(.+)/i);
      if (commentReason) {
        reason = commentReason[1].trim();
      } else if (!commentExpires) {
        reason = commentPart;
      }
    }
    remaining = patternPart;
  }

  // 4. Colon separator: pattern: reason
  const colonIdx = remaining.indexOf(":");
  if (colonIdx > 0 && !reason) {
    const possiblePattern = remaining.slice(0, colonIdx).trim();
    const possibleReason = remaining.slice(colonIdx + 1).trim();
    if (possiblePattern) {
      remaining = possiblePattern;
      if (possibleReason) {
        reason = possibleReason;
      }
    }
  }

  const pattern = remaining.trim();
  return { pattern, reason, expires };
}

/**
 * Parses `.secureflowignore` content into structured configuration.
 *
 * Supports:
 * - Plain glob patterns (backward compatible)
 * - Entries with optional `reason` and optional `expires` date
 * - Expired entries are filtered out of `ignoredPaths` and tracked in `expiredRules`
 * - Malformed dates are reported in warnings and ignored without failing or crashing
 * - Entries without reasons trigger a warning
 * - Sections: `[paths]`, `[files]`, `[placeholders]`, `[mocks]`
 */
export function parseSecureFlowIgnore(
  content: string,
  options?: ParseSecureFlowIgnoreOptions,
): SecureFlowIgnoreConfig {
  const ignoredPaths: string[] = [];
  const placeholders: string[] = [];
  const rules: IgnoreRuleEntry[] = [];
  const expiredRules: ExpiredIgnoreRule[] = [];
  const warnings: string[] = [];

  const now = options?.now ?? new Date();

  const handleEntry = (entry: { pattern: string; reason?: string; expires?: string }) => {
    const { pattern, reason, expires } = entry;
    if (!pattern) return;

    if (!reason) {
      const msg = `Ignore rule "${pattern}" has no reason specified.`;
      console.warn(`[IgnoreConfig] ${msg}`);
      warnings.push(msg);
    }

    if (expires) {
      const parsedDate = parseExpiryDateUtc(expires);
      if (!parsedDate) {
        const msg = `Invalid expiration date "${expires}" for rule "${pattern}"; ignoring expiration date.`;
        console.warn(`[IgnoreConfig] ${msg}`);
        warnings.push(msg);
        // Invalid date is ignored: rule stays active and scan does not crash
        ignoredPaths.push(pattern);
        rules.push({ pattern, reason, rawExpires: expires });
      } else {
        const isExpired = now.getTime() > parsedDate.getTime();
        if (isExpired) {
          // Expired: stop applying it, track under expiredRules
          expiredRules.push({ pattern, expires, reason });
          rules.push({ pattern, reason, expires, rawExpires: expires });
        } else {
          // Active
          ignoredPaths.push(pattern);
          rules.push({ pattern, reason, expires, rawExpires: expires });
        }
      }
    } else {
      ignoredPaths.push(pattern);
      rules.push({ pattern, reason });
    }
  };

  const trimmed = content.trim();
  // Support full JSON format if the file starts with '{'
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const rawPaths = json.ignoredPaths ?? json.paths;
      if (Array.isArray(rawPaths)) {
        for (const raw of rawPaths) {
          if (typeof raw === "string" && raw.trim()) {
            handleEntry(parseIgnoreRuleLine(raw.trim()));
          } else if (raw && typeof raw === "object") {
            const pattern = raw.pattern ?? raw.path ?? raw.glob;
            if (typeof pattern === "string" && pattern.trim()) {
              handleEntry({
                pattern: pattern.trim(),
                reason:
                  typeof raw.reason === "string" && raw.reason.trim()
                    ? raw.reason.trim()
                    : undefined,
                expires:
                  typeof raw.expires === "string" && raw.expires.trim()
                    ? raw.expires.trim()
                    : typeof raw.expiry === "string" && raw.expiry.trim()
                      ? raw.expiry.trim()
                      : undefined,
              });
            }
          }
        }
      }
      const rawPlaceholders = json.placeholders ?? json.mocks;
      if (Array.isArray(rawPlaceholders)) {
        for (const raw of rawPlaceholders) {
          if (typeof raw === "string" && raw.trim()) {
            placeholders.push(raw.trim());
          }
        }
      }
      return { ignoredPaths, placeholders, rules, expiredRules, warnings };
    } catch {
      // Fall through to line-by-line parsing
    }
  }

  let currentSection: "paths" | "placeholders" = "paths";
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed || lineTrimmed.startsWith("#")) {
      continue;
    }

    const lower = lineTrimmed.toLowerCase();
    if (lower === "[placeholders]" || lower === "[mocks]") {
      currentSection = "placeholders";
      continue;
    }

    if (lower === "[paths]" || lower === "[files]") {
      currentSection = "paths";
      continue;
    }

    if (currentSection === "placeholders") {
      placeholders.push(lineTrimmed);
    } else {
      const parsedEntry = parseIgnoreRuleLine(lineTrimmed);
      handleEntry(parsedEntry);
    }
  }

  return { ignoredPaths, placeholders, rules, expiredRules, warnings };
}
