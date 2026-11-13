/**
 * Terminal UI (TUI) & Pre-Commit Formatting Ergonomics (#1712)
 *
 * Provides interactive terminal formatting utilities:
 * - Animated and static progress spinners for long-running audit steps.
 * - ANSI color-coded warning/violation tables with borders and severity badges.
 * - Husky pre-commit hook auto-configuration (--init flag).
 */

import fs from "node:fs";
import path from "node:path";
import type { FileScanResult, Violation } from "../scanner.js";
import type { AiFinding } from "./api-client.js";

// Standard ANSI styling escapes (supports 16/256-color and gracefully degrades when NO_COLOR is set)
const supportsColor =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR !== "0" || process.stdout.isTTY || process.env.CI === "true");

export const colors = {
  reset: (s: string) => (supportsColor ? `\x1b[0m${s}\x1b[0m` : s),
  bold: (s: string) => (supportsColor ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (supportsColor ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s: string) => (supportsColor ? `\x1b[31m${s}\x1b[39m` : s),
  green: (s: string) => (supportsColor ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s: string) => (supportsColor ? `\x1b[33m${s}\x1b[39m` : s),
  blue: (s: string) => (supportsColor ? `\x1b[34m${s}\x1b[39m` : s),
  magenta: (s: string) => (supportsColor ? `\x1b[35m${s}\x1b[39m` : s),
  cyan: (s: string) => (supportsColor ? `\x1b[36m${s}\x1b[39m` : s),
  gray: (s: string) => (supportsColor ? `\x1b[90m${s}\x1b[39m` : s),
  bgRed: (s: string) => (supportsColor ? `\x1b[41m\x1b[37m${s}\x1b[49m\x1b[39m` : s),
  bgYellow: (s: string) => (supportsColor ? `\x1b[43m\x1b[30m${s}\x1b[49m\x1b[39m` : s),
  bgGreen: (s: string) => (supportsColor ? `\x1b[42m\x1b[30m${s}\x1b[49m\x1b[39m` : s),
  bgBlue: (s: string) => (supportsColor ? `\x1b[44m\x1b[37m${s}\x1b[49m\x1b[39m` : s),
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
    this.stream.write(`\r${colors.green("✔")} ${text}\n`);
  }

  fail(finalText?: string): void {
    this.stop();
    const text = finalText || this.message;
    this.stream.write(`\r${colors.red("✖")} ${text}\n`);
  }

  warn(finalText?: string): void {
    this.stop();
    const text = finalText || this.message;
    this.stream.write(`\r${colors.yellow("⚠")} ${text}\n`);
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

    // Ensure ANSI padding remains aligned
    const padDiff = badge.length - row.severity.length;
    const paddedBadge = badge.padEnd(colWidths.severity + padDiff);

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

export interface InitHookResult {
  success: boolean;
  message: string;
  hookPath: string;
}

export interface InitGreetingOptions {
  version?: string;
  repoUrl?: string;
}

/**
 * Automatically initializes and installs local husky pre-commit hooks (.husky/pre-commit).
 */
export function initHuskyPreCommitHook(targetDir: string = process.cwd()): InitHookResult {
  try {
    const huskyDir = path.join(targetDir, ".husky");
    const preCommitPath = path.join(huskyDir, "pre-commit");

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

    statusSection = [
      `${statusIcon} ${colors.bold(colors.green(`[SecureFlow Init] ${result.message}`))}`,
      `   ${colors.bold("📁 Hook Location:")} ${colors.cyan(result.hookPath || ".husky/pre-commit")}`,
      `   ${colors.bold("⚡ Trigger Script:")} ${colors.magenta("npx secureflow")}${isAlreadyConfigured ? colors.dim(" (active)") : ""}`,
    ].join("\n");
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

  const nextStepsSection = [
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
