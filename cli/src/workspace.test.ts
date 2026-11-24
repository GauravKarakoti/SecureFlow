import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getWorkspacePaths,
  readJsonFile,
  fileExists,
  sandboxWorkspacePath,
  PathTraversalError,
  isBinaryFile,
  discoverWorkspaceFiles,
} from "./workspace";

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

  describe("sandboxWorkspacePath (#1752)", () => {
    it("allows relative paths that remain inside the workspace root", () => {
      const root = makeTmpDir();
      const safeFile = path.join(root, "src", "index.ts");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(safeFile, "export const x = 1;");

      const result = sandboxWorkspacePath("src/index.ts", root);
      expect(result).toBe(fs.realpathSync(safeFile));
    });

    it("rejects traversal patterns that escape workspace root with PathTraversalError", () => {
      const root = makeTmpDir();

      expect(() => sandboxWorkspacePath("../outside.ts", root)).toThrow(PathTraversalError);
      expect(() => sandboxWorkspacePath("src/../../outside.ts", root)).toThrow(PathTraversalError);
    });

    it("detects and rejects symlink escapes outside the workspace boundary", () => {
      const root = makeTmpDir();
      const outsideDir = makeTmpDir();
      const outsideTarget = path.join(outsideDir, "secret.key");
      fs.writeFileSync(outsideTarget, "super-secret");

      const symlinkPath = path.join(root, "symlink-outside");
      try {
        fs.symlinkSync(outsideTarget, symlinkPath);
      } catch {
        // Symlinks may require elevated privileges on Windows; skip if not supported
        return;
      }

      expect(() => sandboxWorkspacePath("symlink-outside", root)).toThrow(PathTraversalError);
    });

    it("rejects non-existent targets with escaping ancestor directories", () => {
      const root = makeTmpDir();
      expect(() => sandboxWorkspacePath("nested/../../../../etc/passwd", root)).toThrow(
        PathTraversalError,
      );
    });

    it("rejects empty or whitespace-only target paths", () => {
      const root = makeTmpDir();
      expect(() => sandboxWorkspacePath("", root)).toThrow(PathTraversalError);
      expect(() => sandboxWorkspacePath("   ", root)).toThrow(PathTraversalError);
    });

    it("accepts valid subdirectories and nested paths without escapes", () => {
      const root = makeTmpDir();
      const subDir = path.join(root, "nested", "child");
      fs.mkdirSync(subDir, { recursive: true });
      const target = path.join(subDir, "file.txt");
      fs.writeFileSync(target, "hello world");

      const sandboxed = sandboxWorkspacePath("nested/child/file.txt", root);
      expect(sandboxed).toBe(fs.realpathSync(target));
    });
  });

  describe("isBinaryFile", () => {
    it("returns false for regular text source code", () => {
      const root = makeTmpDir();
      const textFile = path.join(root, "source.ts");
      fs.writeFileSync(textFile, "export const greeting = 'Hello, world!';\n", "utf-8");

      expect(isBinaryFile(textFile)).toBe(false);
    });

    it("returns true for files containing null bytes", () => {
      const root = makeTmpDir();
      const binFile = path.join(root, "binary.bin");
      const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6c, 0x6f]); // "Hel\0lo"
      fs.writeFileSync(binFile, buffer);

      expect(isBinaryFile(binFile)).toBe(true);
    });
  });

  describe("discoverWorkspaceFiles", () => {
    it("recursively discovers files within target directory", () => {
      const root = makeTmpDir();
      fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "index.ts"), "console.log(1);");
      fs.writeFileSync(path.join(root, "src", "services", "auth.ts"), "console.log(2);");

      const files = discoverWorkspaceFiles("src", { workspaceRoot: root });
      expect(files).toContain("src/index.ts");
      expect(files).toContain("src/services/auth.ts");
    });

    it("skips excluded directories by default", () => {
      const root = makeTmpDir();
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });

      fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "dep");
      fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main");
      fs.writeFileSync(path.join(root, "dist", "bundle.js"), "bundle");
      fs.writeFileSync(path.join(root, "src", "app.ts"), "app");

      const files = discoverWorkspaceFiles(".", { workspaceRoot: root });
      expect(files).toEqual(["src/app.ts"]);
    });

    it("skips binary files and files exceeding size ceiling", () => {
      const root = makeTmpDir();
      fs.mkdirSync(path.join(root, "files"), { recursive: true });

      const textFile = path.join(root, "files", "small.txt");
      fs.writeFileSync(textFile, "small content");

      const binFile = path.join(root, "files", "image.png");
      fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

      const largeFile = path.join(root, "files", "large.txt");
      fs.writeFileSync(largeFile, "x".repeat(100)); // limit to 50 bytes

      const files = discoverWorkspaceFiles("files", {
        workspaceRoot: root,
        maxFileSizeBytes: 50,
      });

      expect(files).toContain("files/small.txt");
      expect(files).not.toContain("files/image.png");
      expect(files).not.toContain("files/large.txt");
    });

    it("respects compiled ignore regex patterns", () => {
      const root = makeTmpDir();
      fs.mkdirSync(path.join(root, "src"), { recursive: true });

      fs.writeFileSync(path.join(root, "src", "index.ts"), "valid");
      fs.writeFileSync(path.join(root, "src", "test.spec.ts"), "test");

      const files = discoverWorkspaceFiles("src", {
        workspaceRoot: root,
        customIgnores: [/.*\.spec\.ts$/i],
      });

      expect(files).toContain("src/index.ts");
      expect(files).not.toContain("src/test.spec.ts");
    });
  });
});
