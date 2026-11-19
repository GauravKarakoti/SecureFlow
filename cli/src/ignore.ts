import fs from "fs";
import path from "path";

export interface IgnoreRuleEntry {
  pattern: string;
  reason?: string | undefined;
  expires?: string | undefined;
  rawExpires?: string | undefined;
}

export interface ExpiredIgnoreRule {
  pattern: string;
  expires: string;
  reason?: string | undefined;
}

export interface SecureFlowIgnoreConfig {
  ignoredPaths: string[];
  placeholders: string[];
  rules?: IgnoreRuleEntry[] | undefined;
  expiredRules?: ExpiredIgnoreRule[] | undefined;
  warnings?: string[] | undefined;
}

export interface ParseSecureFlowIgnoreOptions {
  now?: Date | undefined;
}

/**
 * Normalizes a file path for consistent matching against ignore patterns:
 * converts backslashes to forward slashes, removes leading `./` or `/`.
 */
export function normalizeScanPath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Parse an ISO date or calendar date in YYYY-MM-DD or standard parseable format.
 * Returns null if the date is invalid (e.g. 2026-02-31, 2026-13-45, or "tomorrow").
 * When YYYY-MM-DD is supplied, it is evaluated through the end of that day in UTC (23:59:59.999 UTC).
 */
export function parseExpiryDateUtc(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymdMatch && ymdMatch[1] && ymdMatch[2] && ymdMatch[3]) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }

    return date;
  }

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
  reason?: string | undefined;
  expires?: string | undefined;
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
        return {
          pattern: pattern.trim(),
          ...(reason !== undefined ? { reason } : {}),
          ...(expires !== undefined ? { expires } : {}),
        };
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
  if (expiresMatch && expiresMatch[0] && expiresMatch[1]) {
    expires = expiresMatch[1].trim();
    remaining = remaining.replace(expiresMatch[0], " ").trim();
  }

  // Bracket reason: [reason=...] / [reason: ...]
  const reasonMatch = remaining.match(/\[reason[:=]\s*([^\]]+)\]/i);
  if (reasonMatch && reasonMatch[0] && reasonMatch[1]) {
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
      if (commentExpires && commentExpires[1] && !expires) {
        expires = commentExpires[1].trim();
      }
      const commentReason = commentPart.match(/reason[:=]\s*(.+)/i);
      if (commentReason && commentReason[1]) {
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
  return {
    pattern,
    ...(reason !== undefined ? { reason } : {}),
    ...(expires !== undefined ? { expires } : {}),
  };
}

/**
 * Parses the raw text of a `.secureflowignore` file into structured configuration.
 *
 * Supports comments (`#`), whitespace trimming, and optional section headers:
 * - `[paths]` or `[files]`: file paths and glob patterns to ignore
 * - `[placeholders]` or `[mocks]`: test credential values/patterns to suppress
 * - entries with optional reason and expires date
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

  const handleEntry = (entry: {
    pattern: string;
    reason?: string | undefined;
    expires?: string | undefined;
  }) => {
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
        ignoredPaths.push(pattern);
        rules.push({
          pattern,
          ...(reason !== undefined ? { reason } : {}),
          rawExpires: expires,
        });
      } else {
        const isExpired = now.getTime() > parsedDate.getTime();
        if (isExpired) {
          expiredRules.push({
            pattern,
            expires,
            ...(reason !== undefined ? { reason } : {}),
          });
          rules.push({
            pattern,
            expires,
            rawExpires: expires,
            ...(reason !== undefined ? { reason } : {}),
          });
        } else {
          ignoredPaths.push(pattern);
          rules.push({
            pattern,
            expires,
            rawExpires: expires,
            ...(reason !== undefined ? { reason } : {}),
          });
        }
      }
    } else {
      ignoredPaths.push(pattern);
      rules.push({
        pattern,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  };

  const trimmed = content.trim();
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
      const parsed = parseIgnoreRuleLine(trimmed);
      handleEntry(parsed);
    }
  }

  return { ignoredPaths, placeholders, rules, expiredRules, warnings };
}

/**
 * Translate one glob into a regular-expression source, reading it left to right.
 *
 * This was a chain of `replace` calls over the already-escaped string. The
 * single-`*` step skipped any `*` next to a `.`, to leave alone the `.*` that
 * `**` had become — but an escaped literal dot looks the same, so the `*` in
 * `config.*` (escaped to `config\.*`) survived as a regex quantifier, "zero or
 * more dots". `config.*` never matched `config.json`, nor `*.test.*`
 * `src/a.test.ts`. A single pass leaves nothing for a later step to misread.
 * Kept identical to the server's copy in `src/lib/armor/scanner.ts`.
 */
export function globToRegexSource(glob: string): string {
  let out = "";

  for (let i = 0; i < glob.length;) {
    if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      out += "(?:/.*)?"; // trailing `/**`: the directory itself or anything below it
      i += 3;
    } else if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?"; // any number of directories, including none
      i += 3;
    } else if (glob.startsWith("**", i)) {
      // `**` is only recursive as a whole path segment; `a**b` is one segment.
      const segmentStart = i === 0 || glob[i - 1] === "/";
      const segmentEnd = i + 2 === glob.length || glob[i + 2] === "/";
      out += segmentStart && segmentEnd ? ".*" : "[^/]*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += glob[i]!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }

  return out;
}

/**
 * Compiles an array of glob strings into RegExp patterns for path matching.
 */
export function compileIgnorePatterns(patterns: string[]): RegExp[] {
  return patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"))
    .map((p) => {
      const pattern = p.replace(/\\/g, "/");
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

      const regexStr = globToRegexSource(glob);

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
