import fs from "fs";
import path from "path";
import readline from "readline";
import { isGitRepository, getGitHooksDir } from "./git.js";

export const HOOK_MARKER = "secureflow-pre-commit-hook-v1";
export const BACKUP_SUFFIX = ".secureflow.bak";

export const DEFAULT_PRE_COMMIT_SCRIPT = `#!/bin/sh
# Installed by SecureFlow (https://github.com/GauravKarakoti/SecureFlow)
# secureflow-pre-commit-hook-v1
# Automatically scans staged changes to block secrets before commit (#2020).

if command -v secureflow-cli >/dev/null 2>&1; then
  exec secureflow-cli scan --staged "$@"
elif command -v secureflow >/dev/null 2>&1; then
  exec secureflow scan --staged "$@"
elif [ -f "./node_modules/.bin/secureflow" ]; then
  exec ./node_modules/.bin/secureflow scan --staged "$@"
else
  npx --no-install secureflow scan --staged "$@"
fi
`;

export interface HookInstallOptions {
  cwd?: string;
  force?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface HookUninstallOptions {
  cwd?: string;
  dryRun?: boolean;
}

export interface HookResult {
  success: boolean;
  message: string;
  hookPath?: string | undefined;
  backupPath?: string | undefined;
}

async function askConfirmation(
  question: string,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Installs the SecureFlow pre-commit hook into the active Git repository.
 * Preserves and backs up existing hooks and never overwrites without confirmation (#2020).
 */
export async function installHook(options: HookInstallOptions = {}): Promise<HookResult> {
  const cwd = options.cwd ?? process.cwd();

  if (!isGitRepository(cwd)) {
    return {
      success: false,
      message: "❌ [SecureFlow] Not a git repository (or git is not on PATH). Cannot install hook.",
    };
  }

  const hooksDir = getGitHooksDir(cwd);
  const hookPath = path.join(hooksDir, "pre-commit");
  const backupPath = `${hookPath}${BACKUP_SUFFIX}`;

  if (fs.existsSync(hookPath)) {
    const existingContent = fs.readFileSync(hookPath, "utf-8");
    const isOurHook =
      existingContent.includes(HOOK_MARKER) ||
      (existingContent.includes("secureflow") && existingContent.includes("--staged"));

    if (isOurHook && !options.force) {
      return {
        success: true,
        message: `ℹ️  [SecureFlow] Pre-commit hook is already configured at ${hookPath}`,
        hookPath,
      };
    }

    if (!isOurHook) {
      let canOverwrite = Boolean(options.force);

      if (!canOverwrite) {
        const isInteractive =
          options.interactive ??
          (Boolean(options.stdin) || (Boolean(process.stdin.isTTY) && !process.env.CI));

        if (isInteractive) {
          const promptMsg = `⚠️  [SecureFlow] An existing pre-commit hook was found at ${hookPath}.\nOverwrite and back up existing hook to ${path.basename(backupPath)}? (y/N) `;
          canOverwrite = await askConfirmation(promptMsg, options.stdin, options.stdout);
        }
      }

      if (!canOverwrite) {
        return {
          success: false,
          message: `⚠️  [SecureFlow] Installation cancelled. Existing pre-commit hook at ${hookPath} was preserved. Use --force to back up and replace it.`,
          hookPath,
        };
      }

      // Back up existing hook
      if (!options.dryRun) {
        fs.copyFileSync(hookPath, backupPath);
      }
    }
  } else if (!options.dryRun) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  if (!options.dryRun) {
    fs.writeFileSync(hookPath, DEFAULT_PRE_COMMIT_SCRIPT, { mode: 0o755 });
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      // Ignore chmod failures on non-POSIX platforms
    }
  }

  const backupMsg = fs.existsSync(backupPath)
    ? ` (previous hook backed up to ${path.basename(backupPath)})`
    : "";
  return {
    success: true,
    message: `✅ [SecureFlow] Successfully installed pre-commit hook at ${hookPath}${backupMsg}`,
    hookPath,
    backupPath: fs.existsSync(backupPath) ? backupPath : undefined,
  };
}

/**
 * Uninstalls the SecureFlow pre-commit hook and restores any previous hook backup (#2020).
 */
export async function uninstallHook(options: HookUninstallOptions = {}): Promise<HookResult> {
  const cwd = options.cwd ?? process.cwd();

  if (!isGitRepository(cwd)) {
    return {
      success: false,
      message: "❌ [SecureFlow] Not a git repository (or git is not on PATH).",
    };
  }

  const hooksDir = getGitHooksDir(cwd);
  const hookPath = path.join(hooksDir, "pre-commit");
  const backupPath = `${hookPath}${BACKUP_SUFFIX}`;

  const hasHook = fs.existsSync(hookPath);
  const hasBackup = fs.existsSync(backupPath);

  if (!hasHook && !hasBackup) {
    return {
      success: true,
      message: `ℹ️  [SecureFlow] No pre-commit hook found at ${hookPath}`,
      hookPath,
    };
  }

  if (hasBackup) {
    if (!options.dryRun) {
      fs.copyFileSync(backupPath, hookPath);
      fs.unlinkSync(backupPath);
      try {
        fs.chmodSync(hookPath, 0o755);
      } catch {
        // Ignore chmod failures
      }
    }
    return {
      success: true,
      message: `✅ [SecureFlow] Restored previous pre-commit hook from backup at ${backupPath}`,
      hookPath,
      backupPath,
    };
  }

  if (hasHook) {
    const content = fs.readFileSync(hookPath, "utf-8");
    const isOurHook =
      content.includes(HOOK_MARKER) ||
      (content.includes("secureflow") && content.includes("--staged"));

    if (!isOurHook) {
      return {
        success: true,
        message: `⚠️  [SecureFlow] Existing pre-commit hook at ${hookPath} was not created by SecureFlow. Left unchanged.`,
        hookPath,
      };
    }

    if (!options.dryRun) {
      fs.unlinkSync(hookPath);
    }
    return {
      success: true,
      message: `✅ [SecureFlow] Successfully uninstalled pre-commit hook at ${hookPath}`,
      hookPath,
    };
  }

  return {
    success: true,
    message: `ℹ️  [SecureFlow] Nothing to uninstall.`,
  };
}

export function printHookHelp(): void {
  console.log(`
SecureFlow CLI - Git Hook Manager

Usage:
  secureflow hook <command> [options]
  secureflow-cli hook <command> [options]

Commands:
  install      Install a Git pre-commit hook that automatically runs 'secureflow scan --staged'
  uninstall    Uninstall the Git pre-commit hook and restore any previous hook backup

Options:
  --force, -f  Overwrite existing hook without interactive confirmation (backs up existing hook)
  --dry-run    Simulate hook installation or uninstallation without writing files
  -h, --help   Show this help message
`);
}
