/**
 * Custom Vitest reporter that lists all failed test suites/files at the end of the test run (#1719).
 * Avoids having to scroll up through thousands of lines of failure traces.
 */

const supportsColor =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR !== "0" || process.stdout?.isTTY || process.env.CI === "true");

const colors = {
  red: (s: string) => (supportsColor ? `\x1b[31m${s}\x1b[39m` : s),
  bold: (s: string) => (supportsColor ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (supportsColor ? `\x1b[2m${s}\x1b[22m` : s),
};

export function isTestModuleFailed(m: any): boolean {
  if (!m) return false;
  if (typeof m.ok === "function") {
    if (!m.ok()) return true;
  } else if (m.ok === false) {
    return true;
  }

  const state = typeof m.state === "function" ? m.state() : m.state;
  if (state === "failed" || state === "fail") {
    return true;
  }

  const errors = typeof m.errors === "function" ? m.errors() : m.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return true;
  }

  if (m.result?.state === "failed" || m.result?.state === "fail") {
    return true;
  }

  return false;
}

export function getModulePath(m: any, cwd: string = process.cwd()): string {
  if (m.relativeModuleId) {
    return m.relativeModuleId.replace(/\\/g, "/");
  }
  const rawPath = m.moduleId || m.filepath || m.name || "";
  if (!rawPath) return "";

  const normalizedRaw = rawPath.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/");

  if (normalizedRaw.startsWith(normalizedCwd + "/")) {
    return normalizedRaw.slice(normalizedCwd.length + 1);
  }
  return normalizedRaw;
}

export function getFailedFilePaths(modules: any[], cwd: string = process.cwd()): string[] {
  const failed: string[] = [];
  for (const m of modules || []) {
    if (isTestModuleFailed(m)) {
      const filePath = getModulePath(m, cwd);
      if (filePath && !failed.includes(filePath)) {
        failed.push(filePath);
      }
    }
  }
  return failed;
}

export function formatFailedFilesSummary(failedFiles: string[]): string {
  if (!failedFiles || failedFiles.length === 0) return "";

  const count = failedFiles.length;
  const header = `\n${colors.bold(colors.red(`⎯⎯⎯⎯⎯⎯⎯ Failed Test Files (${count}) ⎯⎯⎯⎯⎯⎯⎯`))}\n`;
  const list = failedFiles.map((file) => ` ${colors.red("✖")} ${colors.bold(file)}`).join("\n");
  return `${header}${list}\n`;
}

export class FailedTestsReporter {
  private ctx: any;
  private reported = false;

  onInit(ctx: any) {
    this.ctx = ctx;
    this.reported = false;
  }

  onTestRunStart() {
    this.reported = false;
  }

  onTestRunEnd(testModules: any[]) {
    if (this.reported) return;
    const failedFiles = getFailedFilePaths(testModules);
    if (failedFiles.length > 0) {
      this.reported = true;
      const summary = formatFailedFilesSummary(failedFiles);
      if (this.ctx?.logger?.log) {
        this.ctx.logger.log(summary);
      } else {
        console.log(summary);
      }
    }
  }

  onFinished(files?: any[]) {
    if (this.reported) return;
    if (files && files.length > 0) {
      const failedFiles = getFailedFilePaths(files);
      if (failedFiles.length > 0) {
        this.reported = true;
        const summary = formatFailedFilesSummary(failedFiles);
        if (this.ctx?.logger?.log) {
          this.ctx.logger.log(summary);
        } else {
          console.log(summary);
        }
      }
    }
  }
}

export default FailedTestsReporter;
