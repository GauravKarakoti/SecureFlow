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
  'lock.json', '.lock', 'lock.yaml', '.csv',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz',
  '.md', 'tsconfig.json'
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
  'dist/', 'build/', '.next/', 'node_modules/', 'prisma/migrations/'
] as const;

/**
 * Configuration files whose contents are structure rather than logic.
 *
 * Matched on the basename, so `package.json` is ignored and
 * `tools/package.json.generator.ts` — which is ordinary TypeScript that can
 * hold a credential like any other file — is not.
 */
export const IGNORED_BASENAMES = [
  'package.json', 'components.json', 'prisma.config.ts', '.gitignore'
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
  return filename
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/** The path's segments, with empty ones (from `a//b`) dropped. */
export function pathSegments(normalizedPath: string): string[] {
  return normalizedPath.split('/').filter((segment) => segment.length > 0);
}

/** The filename, without its directories. */
export function basenameOf(normalizedPath: string): string {
  const segments = pathSegments(normalizedPath);
  return segments.length > 0 ? segments[segments.length - 1] : '';
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
export type IgnoreReason = 'directory' | 'extension' | 'config-file' | 'custom' | null;

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
  if (typeof filename !== 'string' || filename.trim() === '') return null;

  const normalized = normalizeScanPath(filename);

  if (IGNORED_DIRECTORIES.some((rule) => isUnderIgnoredDirectory(normalized, rule))) {
    return 'directory';
  }

  if (hasIgnoredExtension(normalized)) {
    return 'extension';
  }

  // `.env.example` is deliberately NOT ignored here: the scanner has a dedicated
  // context hint and false-positive filter for template files, and a real key
  // committed to one is still a real key.
  if (hasIgnoredBasename(normalized)) {
    return 'config-file';
  }

  const forCustom = filename.replace(/\\/g, '/');
  if (customIgnores.some((pattern) => pattern.test(forCustom))) {
    return 'custom';
  }

  return null;
}

/** Whether the scanner should skip `filename`. */
export function shouldIgnorePath(filename: string, customIgnores: RegExp[] = []): boolean {
  return ignoreReasonFor(filename, customIgnores) !== null;
}
