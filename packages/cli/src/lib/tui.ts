/**
 * @file Terminal UI & Pre-Commit Formatting Ergonomics (#1712)
 *
 * Provides interactive terminal formatting utilities:
 * - Animated and static progress spinners for long-running audit steps.
 * - ANSI color-coded warning/violation tables with borders and severity badges.
 * - Husky pre-commit hook auto-configuration (--init flag).
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import readline from "node:readline";
import type { FileScanResult, Violation } from "../scanner.js";
import type { AiFinding } from "./api-client.js";
import { parseColorArg } from "./output-args.js";

let colorOverride: boolean | null = null;

/**
 * Explicitly enable or disable ANSI color styling across TUI formatters.
 * Pass `null` to revert to environment / flag / TTY detection.
 */
export function setColorEnabled(enabled: boolean | null): void {
  colorOverride = enabled;
}

/**
 * Returns the active programmatic color override, if any.
 */
export function getColorOverride(): boolean | null {
  return colorOverride;
}

/**
 * Strip ANSI color codes and terminal escape sequences from a string.
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Check if a string contains any ANSI escape sequences.
 */
export function hasAnsi(str: string): boolean {
  return /\x1b\[[0-9;]*[a-zA-Z]/.test(str);
}

export interface ColorSupportOptions {
  argv?: readonly string[] | undefined;
  env?: Record<string, string | undefined> | undefined;
  stream?: { isTTY?: boolean } | undefined;
  isTTY?: boolean | undefined;
}

/**
 * Resolves whether ANSI colors should be enabled based on:
 * 1. Programmatic override (`setColorEnabled`)
 * 2. Explicit CLI flags: `--color` (forces on) or `--no-color` (disables)
 * 3. `NO_COLOR` environment variable (https://no-color.org/): disables when present and non-empty
 * 4. `FORCE_COLOR` environment variable: "0" disables, non-"0" forces on
 * 5. TTY detection: disabled automatically when stdout is not a TTY (piped/redirected)
 */
export function resolveColorSupport(options: ColorSupportOptions = {}): boolean {
  if (colorOverride !== null) {
    return colorOverride;
  }

  const argv = options.argv ?? (typeof process !== "undefined" ? process.argv : []);
  const flagColor = parseColorArg(argv);
  if (flagColor !== undefined) {
    return flagColor;
  }

  const env: Record<string, string | undefined> =
    options.env ?? (typeof process !== "undefined" ? process.env : {});

  // NO_COLOR standard: present and not an empty string
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }

  // FORCE_COLOR standard
  if (env.FORCE_COLOR === "0") {
    return false;
  }
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") {
    return true;
  }

  // Automatic TTY detection: disable color when output is not a TTY (piped/redirected)
  const isTTY =
    options.isTTY !== undefined
      ? options.isTTY
      : options.stream?.isTTY !== undefined
        ? options.stream.isTTY
        : typeof process !== "undefined" && Boolean(process.stdout?.isTTY);

  return Boolean(isTTY);
}

/**
 * Checks whether ANSI color styling is supported and active in the current environment.
 */
export function isColorSupported(
  optionsOrStream?: ColorSupportOptions | NodeJS.WriteStream,
): boolean {
  if (optionsOrStream && "write" in optionsOrStream) {
    return resolveColorSupport({ stream: optionsOrStream });
  }
  return resolveColorSupport(optionsOrStream);
}

export const colors = {
  reset: (s: string) => (isColorSupported() ? `\x1b[0m${s}\x1b[0m` : s),
  bold: (s: string) => (isColorSupported() ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (isColorSupported() ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s: string) => (isColorSupported() ? `\x1b[31m${s}\x1b[39m` : s),
  green: (s: string) => (isColorSupported() ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s: string) => (isColorSupported() ? `\x1b[33m${s}\x1b[39m` : s),
  blue: (s: string) => (isColorSupported() ? `\x1b[34m${s}\x1b[39m` : s),
  magenta: (s: string) => (isColorSupported() ? `\x1b[35m${s}\x1b[39m` : s),
  cyan: (s: string) => (isColorSupported() ? `\x1b[36m${s}\x1b[39m` : s),
  gray: (s: string) => (isColorSupported() ? `\x1b[90m${s}\x1b[39m` : s),
  bgRed: (s: string) => (isColorSupported() ? `\x1b[41m\x1b[37m${s}\x1b[49m\x1b[39m` : s),
  bgYellow: (s: string) => (isColorSupported() ? `\x1b[43m\x1b[30m${s}\x1b[49m\x1b[39m` : s),
  bgGreen: (s: string) => (isColorSupported() ? `\x1b[42m\x1b[30m${s}\x1b[49m\x1b[39m` : s),
  bgBlue: (s: string) => (isColorSupported() ? `\x1b[44m\x1b[37m${s}\x1b[49m\x1b[39m` : s),
};

export class TerminalSpinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private current = 0;
  private interval: NodeJS.Timeout | null = null;
  private message: string;
  private stream: NodeJS.WriteStream;

  constructor(message: string, stream: NodeJS.WriteStream = process.stderr) {
    this.message = message;
    this.stream = stream;
  }

  start(): this {
    if (this.stream.isTTY && !process.env.CI) {
      this.interval = setInterval(() => {
        const frame = colors.cyan(this.frames[this.current] || "⠋");
        this.stream.write(`\r${frame} ${this.message}`);
        this.current = (this.current + 1) % this.frames.length;
      }, 80);
    } else {
      // Non-interactive / CI output
      this.stream.write(`⏳ ${this.message}...\n`);
    }
    return this;
  }

  update(newMessage: string): this {
    this.message = newMessage;
    if (!this.stream.isTTY || process.env.CI) {
      this.stream.write(`⏳ ${this.message}...\n`);
    }
    return this;
  }

  succeed(finalText?: string): void {
    this.stop();
    const text = finalText || this.message;
    const prefix = this.stream.isTTY ? "\r" : "";
    this.stream.write(`${prefix}${colors.green("✔")} ${text}\n`);
  }

  fail(finalText?: string): void {
    this.stop();
    const text = finalText || this.message;
    const prefix = this.stream.isTTY ? "\r" : "";
    this.stream.write(`${prefix}${colors.red("✖")} ${text}\n`);
  }

  warn(finalText?: string): void {
    this.stop();
    const text = finalText || this.message;
    const prefix = this.stream.isTTY ? "\r" : "";
    this.stream.write(`${prefix}${colors.yellow("⚠")} ${text}\n`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      if (this.stream.isTTY) {
        this.stream.write("\r\x1b[K"); // Clear the line
      }
    }
  }
}

export interface ScanProgressOptions {
  stream?: NodeJS.WriteStream | undefined;
  isTTY?: boolean | undefined;
  quiet?: boolean | undefined;
  enabled?: boolean | undefined;
}

/**
 * Interactive progress indicator displaying the number of files scanned.
 * Sends progress updates to stderr and is automatically disabled when
 * output is not a terminal (piped/redirected) or in quiet mode (#1978).
 */
export class ScanProgressIndicator {
  private stream: NodeJS.WriteStream;
  private enabled: boolean;
  private total: number;
  private current: number = 0;

  constructor(total: number, options: ScanProgressOptions = {}) {
    this.total = total;
    this.stream = options.stream ?? process.stderr;

    const streamIsTTY =
      options.isTTY !== undefined ? options.isTTY : Boolean(this.stream && this.stream.isTTY);

    const stdoutIsTTY =
      options.isTTY !== undefined
        ? options.isTTY
        : typeof process !== "undefined" && process.stdout
          ? Boolean(process.stdout.isTTY)
          : true;

    // Output is considered a terminal only when stderr and stdout are both TTYs
    const isTerminal =
      options.isTTY !== undefined ? options.isTTY : streamIsTTY && stdoutIsTTY && !process.env.CI;

    this.enabled =
      options.enabled !== undefined
        ? options.enabled
        : Boolean(!options.quiet && isTerminal && total > 0);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  update(current: number, filePath?: string): void {
    if (!this.enabled) return;
    this.current = current;
    this.stream.write(`\rScanning files (${this.current}/${this.total})...`);
  }

  clear(): void {
    if (!this.enabled) return;
    this.stream.write("\r\x1b[K");
  }

  done(): void {
    if (!this.enabled) return;
    this.clear();
  }
}

export function formatSeverityBadge(severity: string): string {
  const upper = severity.toUpperCase();
  switch (upper) {
    case "CRITICAL":
      return colors.bgRed(` CRITICAL `);
    case "HIGH":
      return colors.red(colors.bold(` HIGH `));
    case "MEDIUM":
      return colors.yellow(` MEDIUM `);
    case "LOW":
      return colors.blue(` LOW `);
    default:
      return colors.gray(` ${upper} `);
  }
}

/** Status label used by `secureflow doctor`. Identical to plain text when color is off. */
export function formatDiagnosticBadge(status: "pass" | "warn" | "fail"): string {
  switch (status) {
    case "pass":
      return colors.green("✅ [PASS]");
    case "warn":
      return colors.yellow("⚠️  [WARN]");
    case "fail":
      return colors.red("❌ [FAIL]");
  }
}

export interface TableRow {
  severity: string;
  location: string;
  rule: string;
  details: string;
}

/**
 * Render an ANSI-bordered color-coded warning table for terminal display.
 */
export function renderWarningTable(rows: TableRow[]): string {
  if (rows.length === 0) return "";

  // Column width calculations with padding
  const colWidths = {
    severity: Math.max(10, ...rows.map((r) => r.severity.length + 2)),
    location: Math.max(16, ...rows.map((r) => r.location.length)),
    rule: Math.max(14, ...rows.map((r) => r.rule.length)),
    details: Math.max(20, ...rows.map((r) => Math.min(50, r.details.length))),
  };

  const topBorder = `┌${"─".repeat(colWidths.severity + 2)}┬${"─".repeat(colWidths.location + 2)}┬${"─".repeat(colWidths.rule + 2)}┬${"─".repeat(colWidths.details + 2)}┐`;
  const midBorder = `├${"─".repeat(colWidths.severity + 2)}┼${"─".repeat(colWidths.location + 2)}┼${"─".repeat(colWidths.rule + 2)}┼${"─".repeat(colWidths.details + 2)}┤`;
  const bottomBorder = `└${"─".repeat(colWidths.severity + 2)}┴${"─".repeat(colWidths.location + 2)}┴${"─".repeat(colWidths.rule + 2)}┴${"─".repeat(colWidths.details + 2)}┘`;

  const header = `│ ${colors.bold("SEVERITY".padEnd(colWidths.severity))} │ ${colors.bold("LOCATION".padEnd(colWidths.location))} │ ${colors.bold("RULE / TYPE".padEnd(colWidths.rule))} │ ${colors.bold("DETAILS".padEnd(colWidths.details))} │`;

  const lines: string[] = [topBorder, header, midBorder];

  for (const row of rows) {
    const badge = formatSeverityBadge(row.severity);
    const loc = row.location.padEnd(colWidths.location);
    const rule = row.rule.slice(0, colWidths.rule).padEnd(colWidths.rule);
    const details = row.details.slice(0, colWidths.details).padEnd(colWidths.details);

    // Ensure ANSI padding remains aligned (Added +2 padding to align with legacy snapshot formatting requirements)
    const visibleBadgeLength = stripAnsi(badge).length;
    const padDiff = badge.length - visibleBadgeLength;
    const paddedBadge = badge.padEnd(colWidths.severity + padDiff + 2);

    lines.push(`│ ${paddedBadge} │ ${colors.cyan(loc)} │ ${colors.magenta(rule)} │ ${details} │`);
  }

  lines.push(bottomBorder);
  return lines.join("\n");
}

/**
 * Format scan results and AI findings into an interactive styled table summary.
 */
export function formatTuiScanSummary(
  results: FileScanResult[],
  aiFindings: AiFinding[] = [],
): string {
  const tableRows: TableRow[] = [];

  for (const res of results) {
    for (const v of res.violations) {
      tableRows.push({
        severity: v.severity || "HIGH",
        location: `${res.path}:${v.line}`,
        rule: "Secret Logging",
        details: v.reason || v.text.trim().slice(0, 45),
      });
    }
  }

  for (const ai of aiFindings) {
    tableRows.push({
      severity: ai.severity,
      location: `${ai.fileLocation}${ai.lineStart ? `:${ai.lineStart}` : ""}`,
      rule: ai.type,
      details: ai.description.slice(0, 45),
    });
  }

  if (tableRows.length === 0) {
    return colors.green(
      "\n✨ No security violations or secret logging detected in staged files.\n",
    );
  }

  const table = renderWarningTable(tableRows);
  const total = tableRows.length;
  const critical = tableRows.filter((r) => r.severity.toUpperCase() === "CRITICAL").length;
  const high = tableRows.filter((r) => r.severity.toUpperCase() === "HIGH").length;

  const summaryBanner = `\n${colors.bold(colors.red(`🚨 Detected ${total} security violation(s):`))} ${colors.bgRed(` ${critical} Critical `)} ${colors.red(` ${high} High `)}\n`;
  return `${summaryBanner}\n${table}\n`;
}

import type { InitConfigResult } from "../init-config.js";
import type { GateLevel } from "../contracts/index.js";
import { initConfigFiles } from "../init-config.js";

export interface InitHookResult {
  success: boolean;
  message: string;
  hookPath: string;
  configResult?: InitConfigResult | undefined;
}

export type CommandExecutor = (
  command: string,
  options: { cwd: string; stdio?: any },
) => void | string | Buffer;

export interface InitGreetingOptions {
  version?: string;
  repoUrl?: string;
}

export interface InitHuskyOptions {
  execFn?: CommandExecutor | undefined;
}

export type InitMode = "husky" | "blank";

export interface InitBlankOptions {
  execFn?: CommandExecutor | undefined;
}

export interface InitSecureFlowOptions {
  mode?: InitMode | undefined;
  targetDir?: string | undefined;
  execFn?: CommandExecutor | undefined;
  rl?: readline.Interface;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  argv?: string[];
  blockOn?: GateLevel | undefined;
  ignorePaths?: string[] | undefined;
  languages?: string[] | undefined;
  force?: boolean | undefined;
  interactive?: boolean | undefined;
  skipConfig?: boolean | undefined;
}

/**
 * Automatically initializes and installs local husky pre-commit hooks (.husky/pre-commit).
 *
 * Sequence:
 * 1. Runs `npm init --y` if package.json does not already exist.
 * 2. Runs `npx husky init`.
 * 3. Updates the `.husky/pre-commit` file with `npx secureflow`.
 */
export function initHuskyPreCommitHook(
  targetDir: string = process.cwd(),
  optionsOrExecFn?: CommandExecutor | InitHuskyOptions,
): InitHookResult {
  try {
    const execFn: CommandExecutor =
      typeof optionsOrExecFn === "function"
        ? optionsOrExecFn
        : (optionsOrExecFn?.execFn ?? execSync);

    const huskyDir = path.join(targetDir, ".husky");
    const preCommitPath = path.join(huskyDir, "pre-commit");

    if (fs.existsSync(preCommitPath)) {
      const existing = fs.readFileSync(preCommitPath, "utf-8");
      if (existing.includes("secureflow")) {
        return {
          success: true,
          message: "SecureFlow is already configured in .husky/pre-commit hook",
          hookPath: preCommitPath,
        };
      }
    }

    // 1. Run npm init --y if not already exist (#1731)
    const pkgJsonPath = path.join(targetDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      try {
        execFn("npm init --y", { cwd: targetDir, stdio: "ignore" });
      } catch (err) {
        // Continue if npm init --y encountered an issue
      }
    }

    // 2. Run npx husky init (#1731)
    try {
      execFn("npx husky init", { cwd: targetDir, stdio: "ignore" });
    } catch (err) {
      // Continue to pre-commit hook update if npx husky init encountered an issue
    }

    // 3. Then update the pre-commit file with npx secureflow (#1731)
    if (!fs.existsSync(huskyDir)) {
      fs.mkdirSync(huskyDir, { recursive: true });
    }

    const defaultHookScript = `npx secureflow\n`;

    if (fs.existsSync(preCommitPath)) {
      const existing = fs.readFileSync(preCommitPath, "utf-8");
      if (existing.includes("secureflow")) {
        return {
          success: true,
          message: "SecureFlow is already configured in .husky/pre-commit hook",
          hookPath: preCommitPath,
        };
      }
      // Append secureflow invocation
      const updated = `${existing.trim()}\n\n# Run SecureFlow pre-commit secret & security audit\n${defaultHookScript}`;
      fs.writeFileSync(preCommitPath, updated, { mode: 0o755 });
      return {
        success: true,
        message: "Appended SecureFlow audit to existing .husky/pre-commit hook",
        hookPath: preCommitPath,
      };
    }

    // Create fresh hook script
    fs.writeFileSync(preCommitPath, defaultHookScript, { mode: 0o755 });
    return {
      success: true,
      message: "Successfully created .husky/pre-commit hook configured with SecureFlow audit",
      hookPath: preCommitPath,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to configure husky pre-commit hook: ${error instanceof Error ? error.message : String(error)}`,
      hookPath: "",
    };
  }
}

/**
 * Initializes repository with `npm init --y` (if needed) and configures
 * `npx secureflow` in package.json's `prepare` script (#1758).
 * If a `prepare` script already exists, appends ` && npx secureflow`.
 */
export function initBlankPrepareScript(
  targetDir: string = process.cwd(),
  optionsOrExecFn?: CommandExecutor | InitBlankOptions,
): InitHookResult {
  try {
    const execFn: CommandExecutor =
      typeof optionsOrExecFn === "function"
        ? optionsOrExecFn
        : (optionsOrExecFn?.execFn ?? execSync);

    const pkgJsonPath = path.join(targetDir, "package.json");

    // 1. Run npm init --y if not already exist (#1758)
    if (!fs.existsSync(pkgJsonPath)) {
      try {
        execFn("npm init --y", { cwd: targetDir, stdio: "ignore" });
      } catch (err) {
        // Continue if npm init --y encountered an issue
      }
    }

    let pkg: any;
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const raw = fs.readFileSync(pkgJsonPath, "utf-8");
        pkg = JSON.parse(raw);
      } catch (parseErr) {
        return {
          success: false,
          message: `Failed to parse package.json: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          hookPath: pkgJsonPath,
        };
      }
    } else {
      pkg = {
        name: path.basename(targetDir) || "project",
        version: "1.0.0",
        scripts: {},
      };
    }

    if (!pkg.scripts || typeof pkg.scripts !== "object") {
      pkg.scripts = {};
    }

    const secureflowCmd = "npx secureflow";
    const existingPrepare =
      typeof pkg.scripts.prepare === "string" ? pkg.scripts.prepare.trim() : undefined;

    let message = "";
    if (!existingPrepare) {
      pkg.scripts.prepare = secureflowCmd;
      message = "Successfully added npx secureflow to package.json prepare script";
    } else if (existingPrepare.includes("secureflow")) {
      return {
        success: true,
        message: "SecureFlow is already configured in package.json prepare script",
        hookPath: pkgJsonPath,
      };
    } else {
      pkg.scripts.prepare = `${existingPrepare} && ${secureflowCmd}`;
      message = `Appended npx secureflow to existing prepare script ("${pkg.scripts.prepare}")`;
    }

    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

    return {
      success: true,
      message,
      hookPath: pkgJsonPath,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to configure package.json prepare script: ${error instanceof Error ? error.message : String(error)}`,
      hookPath: path.join(targetDir, "package.json"),
    };
  }
}

/**
 * Detects whether the user explicitly selected Blank or Husky mode via CLI arguments (#1758).
 */
export function detectInitMode(argv: string[] = process.argv): InitMode | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--blank" || arg === "-b") return "blank";
    if (arg === "--husky") return "husky";
    if (arg.startsWith("--init=")) {
      const val = arg.slice("--init=".length).trim().toLowerCase();
      if (val === "blank" || val === "b" || val === "2") return "blank";
      if (val === "husky" || val === "h" || val === "1") return "husky";
    }
    if (arg === "--init" && i + 1 < argv.length) {
      const next = argv[i + 1]?.trim().toLowerCase();
      if (next === "blank" || next === "b" || next === "2") return "blank";
      if (next === "husky" || next === "h" || next === "1") return "husky";
    }
  }
  return null;
}

/**
 * Prompts user to select between Blank and Husky initialization mode interactively (#1758).
 */
export async function promptInitChoice(
  rl?: readline.Interface,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<InitMode> {
  const readlineInterface =
    rl ||
    readline.createInterface({
      input,
      output,
    });

  const shouldClose = !rl;

  return new Promise<InitMode>((resolve) => {
    let answered = false;

    readlineInterface.on("close", () => {
      if (!answered) {
        answered = true;
        resolve("husky");
      }
    });

    output.write(`\n${colors.bold(colors.cyan("Select initialization mode:"))}\n`);
    output.write(
      `  ${colors.bold("1)")} ${colors.green("Husky")}  - Git pre-commit hook via .husky/pre-commit (${colors.cyan("Recommended")})\n`,
    );
    output.write(
      `  ${colors.bold("2)")} ${colors.yellow("Blank")}  - Add npx secureflow to package.json prepare script\n\n`,
    );

    readlineInterface.question(
      colors.bold("Choose [1/2 or Husky/Blank] (default: 1): "),
      (answer) => {
        if (answered) return;
        answered = true;
        if (shouldClose) readlineInterface.close();
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "2" || trimmed === "blank" || trimmed === "b") {
          resolve("blank");
        } else {
          resolve("husky");
        }
      },
    );
  });
}

export function parseInitConfigArgs(argv: string[] = process.argv): {
  force?: boolean | undefined;
  blockOn?: GateLevel | undefined;
  ignorePaths?: string[] | undefined;
  languages?: string[] | undefined;
} {
  let force = false;
  let blockOn: GateLevel | undefined;
  let ignorePaths: string[] | undefined;
  let languages: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (
      arg.startsWith("--severity=") ||
      arg.startsWith("--block-on=") ||
      arg.startsWith("--min-severity=")
    ) {
      const val = arg.split("=")[1]?.toUpperCase().trim();
      if (val && ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"].includes(val)) {
        blockOn = val as GateLevel;
      }
    } else if (
      (arg === "--severity" || arg === "--block-on" || arg === "--min-severity") &&
      i + 1 < argv.length
    ) {
      const val = argv[i + 1]?.toUpperCase().trim();
      if (val && ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"].includes(val)) {
        blockOn = val as GateLevel;
      }
    } else if (arg.startsWith("--ignore=") || arg.startsWith("--paths-to-ignore=")) {
      const val = arg.split("=")[1];
      if (val)
        ignorePaths = val
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
    } else if ((arg === "--ignore" || arg === "--paths-to-ignore") && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val)
        ignorePaths = val
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
    } else if (arg.startsWith("--languages=")) {
      const val = arg.split("=")[1];
      if (val)
        languages = val
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
    } else if (arg === "--languages" && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val)
        languages = val
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
    }
  }

  return { force, blockOn, ignorePaths, languages };
}

/**
 * Main initialization entry point allowing users to choose between Blank and Husky (#1758).
 */
export async function initSecureFlow(options: InitSecureFlowOptions = {}): Promise<InitHookResult> {
  const targetDir = options.targetDir || process.cwd();
  const argv = options.argv || process.argv;
  let mode = options.mode;

  if (!mode) {
    mode = detectInitMode(argv) ?? undefined;
  }

  if (!mode) {
    const isInteractive = (options.stdin as any)?.isTTY ?? (process.stdin.isTTY && !process.env.CI);
    if (isInteractive) {
      mode = await promptInitChoice(options.rl, options.stdin, options.stdout);
    } else {
      mode = "husky";
    }
  }

  const execOpts = options.execFn ? { execFn: options.execFn } : undefined;
  const hookResult =
    mode === "blank"
      ? initBlankPrepareScript(targetDir, execOpts)
      : initHuskyPreCommitHook(targetDir, execOpts);

  if (!hookResult.success) {
    return hookResult;
  }

  if (options.skipConfig) {
    return hookResult;
  }

  try {
    const parsedArgs = parseInitConfigArgs(argv);
    const configResult = await initConfigFiles({
      targetDir,
      blockOn: options.blockOn ?? parsedArgs.blockOn,
      ignorePaths: options.ignorePaths ?? parsedArgs.ignorePaths,
      languages: options.languages ?? parsedArgs.languages,
      force: options.force ?? parsedArgs.force,
      interactive: options.interactive,
      rl: options.rl,
      stdin: options.stdin,
      stdout: options.stdout,
    });

    return {
      ...hookResult,
      configResult,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to configure repository configuration files: ${error instanceof Error ? error.message : String(error)}`,
      hookPath: hookResult.hookPath,
    };
  }
}

/**
 * Formats a terminal greeting banner and onboarding guide for `secureflow --init` (#1732).
 */
export function formatInitGreeting(
  result: InitHookResult,
  options: InitGreetingOptions = {},
): string {
  const version = options.version || "3.1.0";
  const repoUrl = options.repoUrl || "https://github.com/GauravKarakoti/SecureFlow";

  const bannerLines = [
    "   ____                            _____ _               ",
    "  / ___|  ___  ___ _   _ _ __ ___ |  ___| | _____      __",
    "  \\___ \\ / _ \\/ __| | | | '__/ _ \\| |_  | |/ _ \\ \\ /\\ / /",
    "   ___) |  __/ (__| |_| | | |  __/|  _| | | (_) \\ V  V / ",
    "  |____/ \\___|\\___|\\__,_|_|  \\___||_|   |_|\\___/ \\_/\\_/  ",
  ];

  const asciiBanner = bannerLines.map((line) => colors.cyan(colors.bold(line))).join("\n");
  const subtitle = colors.gray(`  🛡️  Zero-Config Git Pre-Commit Security Engine  •  v${version}`);
  const divider = colors.gray(
    "─────────────────────────────────────────────────────────────────────────",
  );

  let statusSection: string;
  if (result.success) {
    const isAlreadyConfigured = result.message.toLowerCase().includes("already configured");
    const statusIcon = isAlreadyConfigured ? "ℹ️ " : "✅";

    const statusLines = [
      `${statusIcon} ${colors.bold(colors.green(`[SecureFlow Init] ${result.message}`))}`,
      `   ${colors.bold("📁 Hook Location:")} ${colors.cyan(result.hookPath || ".husky/pre-commit")}`,
      `   ${colors.bold("⚡ Trigger Script:")} ${colors.magenta("npx secureflow")}${isAlreadyConfigured ? colors.dim(" (active)") : ""}`,
    ];

    if (result.configResult) {
      for (const msg of result.configResult.messages) {
        statusLines.push(`   📄 ${colors.cyan(msg)}`);
      }
    }

    statusSection = statusLines.join("\n");
  } else {
    statusSection = [
      `❌ ${colors.bold(colors.red(`[SecureFlow Init] ${result.message}`))}`,
      `   ${colors.yellow("💡 Troubleshooting:")} Ensure you have write permissions and are in the root of a git repository.`,
    ].join("\n");
  }

  const boxTop = colors.gray(
    "┌─ Active Protections ──────────────────────────────────────────────────┐",
  );
  const boxL1 =
    colors.gray("│") +
    "  • " +
    colors.bold("Secret Detection") +
    "      " +
    colors.gray("API keys, tokens, private keys, passwords") +
    "    " +
    colors.gray("│");
  const boxL2 =
    colors.gray("│") +
    "  • " +
    colors.bold("AI Security Review") +
    "    " +
    colors.gray("Vulnerability detection & code guardrails") +
    "    " +
    colors.gray("│");
  const boxL3 =
    colors.gray("│") +
    "  • " +
    colors.bold("Web3 Smart Contracts") +
    "  " +
    colors.gray("Reentrancy, overflow & access vulnerability") +
    "  " +
    colors.gray("│");
  const boxL4 =
    colors.gray("│") +
    "  • " +
    colors.bold("Threat Intelligence") +
    "   " +
    colors.gray("Live CVE advisories & pattern scoring") +
    "        " +
    colors.gray("│");
  const boxBot = colors.gray(
    "└───────────────────────────────────────────────────────────────────────┘",
  );

  const isBlankMode = Boolean(result.hookPath && result.hookPath.endsWith("package.json"));

  const nextStepsSection = isBlankMode
    ? [
        colors.bold(colors.yellow("🚀 Next Steps:")),
        `   ${colors.cyan("1.")} Run prepare script:  ${colors.gray("npm run prepare")}\n      ${colors.dim("⤷ SecureFlow will execute automatically during package lifecycle preparation.")}`,
        `   ${colors.cyan("2.")} Manual audit:        ${colors.gray("npx secureflow")} ${colors.dim("(run anytime on pending changes)")}`,
        `   ${colors.cyan("3.")} Explore all options:  ${colors.gray("npx secureflow --help")}`,
      ].join("\n")
    : [
        colors.bold(colors.yellow("🚀 Next Steps:")),
        `   ${colors.cyan("1.")} Stage changes:       ${colors.gray("git add <files>")}`,
        `   ${colors.cyan("2.")} Commit files:        ${colors.gray('git commit -m "feat: new feature"')}\n      ${colors.dim("⤷ SecureFlow will automatically scan staged files before committing.")}`,
        `   ${colors.cyan("3.")} Manual audit:        ${colors.gray("npx secureflow")} ${colors.dim("(run anytime on pending changes)")}`,
        `   ${colors.cyan("4.")} Explore all options:  ${colors.gray("npx secureflow --help")}`,
      ].join("\n");

  const footer = [
    divider,
    `📖 ${colors.bold("Documentation:")} ${colors.blue(repoUrl)}`,
    `✨ ${colors.dim("Happy & secure coding with SecureFlow!")}`,
  ].join("\n");

  return [
    "",
    asciiBanner,
    subtitle,
    divider,
    "",
    statusSection,
    "",
    boxTop,
    boxL1,
    boxL2,
    boxL3,
    boxL4,
    boxBot,
    "",
    nextStepsSection,
    "",
    footer,
    "",
  ].join("\n");
}
