import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
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

describe("workspace module helpers (#1526)", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-workspace-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("getWorkspacePaths", () => {
    it("treats the base directory as cli/src and derives cli and root from it", () => {
      const root = makeTmpDir();
      const paths = getWorkspacePaths(path.join(root, "cli", "src"));

      expect(paths.cliDir).toBe(path.join(root, "cli"));
      expect(paths.rootDir).toBe(root);
    });

    it("places each file in the right directory", () => {
      const root = makeTmpDir();
      const paths = getWorkspacePaths(path.join(root, "cli", "src"));

      expect(paths.cliPackageJsonPath).toBe(path.join(root, "cli", "package.json"));
      expect(paths.nestedLockPath).toBe(path.join(root, "cli", "package-lock.json"));
      expect(paths.rootPackageJsonPath).toBe(path.join(root, "package.json"));
      expect(paths.rootPackageLockPath).toBe(path.join(root, "package-lock.json"));
    });

    it("does not depend on the current working directory", () => {
      const root = makeTmpDir();
      const base = path.join(root, "cli", "src");
      const before = getWorkspacePaths(base);

      const originalCwd = process.cwd();
      process.chdir(os.tmpdir());
      try {
        expect(getWorkspacePaths(base)).toEqual(before);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("readJsonFile", () => {
    it("parses a JSON file", () => {
      const file = path.join(makeTmpDir(), "data.json");
      fs.writeFileSync(file, JSON.stringify({ name: "x", workspaces: ["cli"] }));

      expect(readJsonFile<{ name: string; workspaces: string[] }>(file)).toEqual({
        name: "x",
        workspaces: ["cli"],
      });
    });

    it("throws when the file does not exist", () => {
      expect(() => readJsonFile(path.join(makeTmpDir(), "missing.json"))).toThrow();
    });

    it("throws when the file is not valid JSON", () => {
      const file = path.join(makeTmpDir(), "broken.json");
      fs.writeFileSync(file, "{ not json");

      expect(() => readJsonFile(file)).toThrow();
    });
  });

  describe("fileExists", () => {
    it("is true for an existing file and false for a missing one", () => {
      const dir = makeTmpDir();
      const file = path.join(dir, "package.json");
      fs.writeFileSync(file, "{}");

      expect(fileExists(file)).toBe(true);
      expect(fileExists(path.join(dir, "nope.json"))).toBe(false);
    });
  });
});
