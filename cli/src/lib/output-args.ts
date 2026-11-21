import type { OutputFormat } from "../scanner.js";

/**
 * Parsing for the report flags: `--format`, `-o`/`--output`, `--ignore-file`.
 *
 * Each used to be parsed by its own ad-hoc loop in `index.ts`, and they did not
 * agree with each other or with `--severity`:
 *
 *  - `--format=sarif` and `--output=report.sarif` were not recognised at all
 *    (only the space-separated form was), so `--format=sarif -o out.sarif`
 *    wrote the plain-text report into `out.sarif` and GitHub's SARIF upload
 *    rejected the file.
 *  - An unknown format (`--format sarfi`, `--format xml`) silently fell back to
 *    text instead of failing, so a CI job asking for a machine-readable report
 *    got a human-readable one and exited 0.
 *  - `--ignore-file=<path>` was split on every `=`, cutting a path such as
 *    `conf/a=b.json` down to `conf/a`.
 *
 * All three now accept `--flag value` and `--flag=value` (split on the first
 * `=`), and a missing or unrecognised value is a usage error.
 */

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  "text",
  "json",
  "sarif",
  "csv",
  "html",
  "markdown",
];

/** Accepted spellings that are not themselves format names. */
const FORMAT_ALIASES: Readonly<Record<string, OutputFormat>> = { md: "markdown" };

/**
 * The value given to any of `names`, or `undefined` when none of them appears.
 *
 * Returns `null` when the flag is present without a value — `--format` as the
 * last argument, `--format=`, or `--format --verbose` — so the caller can say
 * so rather than guess.
 */
export function optionValue(
  argv: readonly string[],
  names: readonly string[],
): string | null | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    for (const name of names) {
      if (arg === name) {
        const next = argv[i + 1];
        // A following flag is not a value. A lone "-" is, by convention.
        return next !== undefined && (next === "-" || !next.startsWith("-")) ? next : null;
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1) || null;
      }
    }
  }

  return undefined;
}

/** `--format <text|json|sarif|csv|html|markdown|md>`, defaulting to text. */
export function parseOutputFormat(argv: readonly string[]): OutputFormat {
  const raw = optionValue(argv, ["--format"]);
  if (raw === undefined) return "text";

  const expected = `expected one of: ${OUTPUT_FORMATS.join(", ")}`;
  if (raw === null) {
    throw new CliUsageError(`--format requires a value (${expected})`);
  }

  const value = raw.trim().toLowerCase();
  const format = FORMAT_ALIASES[value] ?? OUTPUT_FORMATS.find((f) => f === value);
  if (!format) {
    throw new CliUsageError(`Unknown --format "${raw}" (${expected})`);
  }

  return format;
}

/** `-o <path>` / `--output <path>`, or `null` for stdout. */
export function parseOutputPath(argv: readonly string[]): string | null {
  const raw = optionValue(argv, ["-o", "--output"]);
  if (raw === undefined) return null;
  if (raw === null) throw new CliUsageError("-o/--output requires a file path");
  return raw;
}

/** `--ignore-file <path>` (alias `--ignore`), or `undefined` for the default lookup. */
export function parseIgnoreFilePath(argv: readonly string[]): string | undefined {
  const raw = optionValue(argv, ["--ignore-file", "--ignore"]);
  if (raw === undefined) return undefined;
  if (raw === null) throw new CliUsageError("--ignore-file requires a file path");
  return raw;
}

/** `-v` / `--voice` flag: play an audio summary debrief. */
export function parseVoiceArg(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--voice" || arg === "-v") return true;
    if (arg.startsWith("--voice=")) {
      const val = arg.slice("--voice=".length).toLowerCase();
      return val !== "false" && val !== "0";
    }
  }
  return false;
}

/** `--since <ref>`, or `undefined` when not specified. */
export function parseSinceArg(argv: readonly string[]): string | undefined {
  const raw = optionValue(argv, ["--since"]);
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim().length === 0) {
    throw new CliUsageError("--since requires a git reference (e.g. --since origin/main)");
  }
  return raw.trim();
}

/**
 * Parse `--color` / `--no-color` CLI flags.
 * Returns `true` if `--color` is specified, `false` if `--no-color` is specified,
 * or `undefined` if neither is specified.
 * When multiple flags appear, the last flag takes precedence.
 */
export function parseColorArg(argv: readonly string[]): boolean | undefined {
  let result: boolean | undefined = undefined;
  for (const arg of argv) {
    if (arg === "--no-color") {
      result = false;
    } else if (arg === "--color") {
      result = true;
    } else if (arg.startsWith("--color=")) {
      const val = arg.slice("--color=".length).toLowerCase();
      if (val === "false" || val === "0" || val === "never") {
        result = false;
      } else if (val === "true" || val === "1" || val === "always" || val === "") {
        result = true;
      }
    } else if (arg.startsWith("--no-color=")) {
      const val = arg.slice("--no-color=".length).toLowerCase();
      result = val === "false" || val === "0" ? true : false;
    }
  }
  return result;
}

/**
 * `--no-cache`: disable scan caching and force fresh analysis.
 */
export function parseNoCacheArg(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--no-cache") return true;
    if (arg.startsWith("--no-cache=")) {
      const val = arg.slice("--no-cache=".length).toLowerCase();
      return val !== "false" && val !== "0";
    }
  }
  return false;
}

/**
 * Parse cache clear command: `cache-clear`, `cache clear`, or `--cache-clear`.
 */
export function parseCacheClearArg(argv: readonly string[]): boolean {
  if (argv.includes("--cache-clear")) return true;
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === "cache-clear") return true;
    if (current === "cache" && argv[i + 1] === "clear") return true;
  }
  return false;
}

/**
 * `--cache-dir <path>`: optional custom cache directory.
 */
export function parseCacheDirArg(argv: readonly string[]): string | undefined {
  const raw = optionValue(argv, ["--cache-dir"]);
  if (raw === undefined) return undefined;
  if (raw === null || raw.trim().length === 0) {
    throw new CliUsageError("--cache-dir requires a directory path");
  }
  return raw.trim();
}
