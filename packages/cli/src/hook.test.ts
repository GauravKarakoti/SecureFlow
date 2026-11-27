import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { PassThrough } from "stream";
import { installHook, uninstallHook, printHookHelp, HOOK_MARKER, BACKUP_SUFFIX } from "./hook.js";
import { getGitHooksDir } from "./git.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@secureflow.io"], {
    cwd: dir,
    stdio: "ignore",
  });
}

describe("Git Hook Management (#2020)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-hook-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("fails gracefully when not inside a git repository", async () => {
    const res = await installHook({ cwd: tempDir });
    expect(res.success).toBe(false);
    expect(res.message).toContain("Not a git repository");

    const unRes = await uninstallHook({ cwd: tempDir });
    expect(unRes.success).toBe(false);
    expect(unRes.message).toContain("Not a git repository");
  });

  it("installs pre-commit hook in a fresh git repository", async () => {
    initGitRepo(tempDir);

    const res = await installHook({ cwd: tempDir });
    expect(res.success).toBe(true);
    expect(res.message).toContain("Successfully installed pre-commit hook");

    const hooksDir = getGitHooksDir(tempDir);
    const hookPath = path.join(hooksDir, "pre-commit");

    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, "utf-8");
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain("scan --staged");
  });

  it("reports already configured when SecureFlow hook is already installed", async () => {
    initGitRepo(tempDir);

    await installHook({ cwd: tempDir });
    const res = await installHook({ cwd: tempDir, force: false });

    expect(res.success).toBe(true);
    expect(res.message).toContain("already configured");
  });

  it("does not overwrite existing foreign hook without confirmation", async () => {
    initGitRepo(tempDir);
    const hooksDir = getGitHooksDir(tempDir);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'custom hook'\n", "utf-8");

    // Non-interactive without force
    const res = await installHook({ cwd: tempDir, force: false, interactive: false });
    expect(res.success).toBe(false);
    expect(res.message).toContain("Existing pre-commit hook at");
    expect(res.message).toContain("preserved");

    // Content should remain untouched
    expect(fs.readFileSync(hookPath, "utf-8")).toBe("#!/bin/sh\necho 'custom hook'\n");
  });

  it("prompts interactively and backs up existing hook on confirmation", async () => {
    initGitRepo(tempDir);
    const hooksDir = getGitHooksDir(tempDir);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    const backupPath = `${hookPath}${BACKUP_SUFFIX}`;
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'custom hook'\n", "utf-8");

    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const installPromise = installHook({
      cwd: tempDir,
      force: false,
      interactive: true,
      stdin,
      stdout,
    });

    stdin.write("y\n");

    const res = await installPromise;
    expect(res.success).toBe(true);
    expect(res.message).toContain("previous hook backed up");

    // Verify backup contains old hook
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf-8")).toBe("#!/bin/sh\necho 'custom hook'\n");

    // Verify pre-commit contains SecureFlow hook
    expect(fs.readFileSync(hookPath, "utf-8")).toContain(HOOK_MARKER);
  });

  it("aborts when user declines confirmation", async () => {
    initGitRepo(tempDir);
    const hooksDir = getGitHooksDir(tempDir);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'custom hook'\n", "utf-8");

    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const installPromise = installHook({
      cwd: tempDir,
      force: false,
      interactive: true,
      stdin,
      stdout,
    });

    stdin.write("n\n");

    const res = await installPromise;
    expect(res.success).toBe(false);
    expect(res.message).toContain("Installation cancelled");
    expect(fs.readFileSync(hookPath, "utf-8")).toBe("#!/bin/sh\necho 'custom hook'\n");
  });

  it("overwrites and backs up existing hook when force is true", async () => {
    initGitRepo(tempDir);
    const hooksDir = getGitHooksDir(tempDir);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    const backupPath = `${hookPath}${BACKUP_SUFFIX}`;
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'custom hook'\n", "utf-8");

    const res = await installHook({ cwd: tempDir, force: true });
    expect(res.success).toBe(true);
    expect(res.message).toContain("previous hook backed up");

    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf-8")).toBe("#!/bin/sh\necho 'custom hook'\n");
    expect(fs.readFileSync(hookPath, "utf-8")).toContain(HOOK_MARKER);
  });

  it("uninstall restores previous hook from backup", async () => {
    initGitRepo(tempDir);
    const hooksDir = getGitHooksDir(tempDir);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    const backupPath = `${hookPath}${BACKUP_SUFFIX}`;
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'custom hook'\n", "utf-8");

    // Install with force to back up
    await installHook({ cwd: tempDir, force: true });
    expect(fs.existsSync(backupPath)).toBe(true);

    // Uninstall
    const unRes = await uninstallHook({ cwd: tempDir });
    expect(unRes.success).toBe(true);
    expect(unRes.message).toContain("Restored previous pre-commit hook from backup");

    // Pre-commit is restored to original content, backup is removed
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, "utf-8")).toBe("#!/bin/sh\necho 'custom hook'\n");
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("uninstall removes SecureFlow hook when no backup exists", async () => {
    initGitRepo(tempDir);
    await installHook({ cwd: tempDir });

    const hooksDir = getGitHooksDir(tempDir);
    const hookPath = path.join(hooksDir, "pre-commit");
    expect(fs.existsSync(hookPath)).toBe(true);

    const unRes = await uninstallHook({ cwd: tempDir });
    expect(unRes.success).toBe(true);
    expect(unRes.message).toContain("Successfully uninstalled");
    expect(fs.existsSync(hookPath)).toBe(false);
  });

  it("uninstall leaves non-SecureFlow hook untouched when no backup exists", async () => {
    initGitRepo(tempDir);
    const hooksDir = getGitHooksDir(tempDir);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'foreign tool hook'\n", "utf-8");

    const unRes = await uninstallHook({ cwd: tempDir });
    expect(unRes.success).toBe(true);
    expect(unRes.message).toContain("not created by SecureFlow");
    expect(fs.readFileSync(hookPath, "utf-8")).toBe("#!/bin/sh\necho 'foreign tool hook'\n");
  });

  it("printHookHelp displays usage instructions", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHookHelp();
    expect(logSpy).toHaveBeenCalled();
    const text = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toContain("secureflow hook <command>");
    expect(text).toContain("install");
    expect(text).toContain("uninstall");
    logSpy.mockRestore();
  });
});
