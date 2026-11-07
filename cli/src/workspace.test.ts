import { describe, it, expect } from "vitest";
import { getWorkspacePaths, readJsonFile, fileExists } from "./workspace";

describe("SecureFlow CLI Workspace Integration (#636)", () => {
  const paths = getWorkspacePaths(__dirname);

  it("resolves the workspace paths from the module's own location by default", () => {
    // The shipped build is ESM ("type": "module"), where __dirname does not
    // exist — the default call must not rely on it.
    const defaults = getWorkspacePaths();
    expect(defaults.cliDir).toBe(paths.cliDir);
    expect(defaults.rootDir).toBe(paths.rootDir);
    expect(fileExists(defaults.cliPackageJsonPath)).toBe(true);
    expect(fileExists(defaults.rootPackageJsonPath)).toBe(true);
  });

  it("verifies cli is properly configured as an npm workspace package", () => {
    const rootPkg = readJsonFile<{ workspaces?: string[] }>(paths.rootPackageJsonPath);
    expect(rootPkg.workspaces).toBeDefined();
    expect(rootPkg.workspaces).toContain("cli");
  });

  it("ensures no isolated package-lock.json remains inside cli workspace", () => {
    expect(fileExists(paths.nestedLockPath)).toBe(false);
  });

  it("ensures cli exports valid bin entry point and build targets", () => {
    const cliPkg = readJsonFile<{ name: string; bin?: Record<string, string> }>(
      paths.cliPackageJsonPath,
    );
    expect(cliPkg.name).toBe("secureflow-cli");
    expect(cliPkg.bin).toBeDefined();
    expect(cliPkg.bin?.secureflow).toBe("dist/index.js");
  });

  it("validates that root package-lock.json manages cli dependencies without collisions", () => {
    expect(fileExists(paths.rootPackageLockPath)).toBe(true);
    const lockJson = readJsonFile<{ lockfileVersion: number }>(paths.rootPackageLockPath);
    expect(lockJson.lockfileVersion).toBeGreaterThanOrEqual(2);
  });
});
