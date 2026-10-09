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
