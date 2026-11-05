import fs from "fs";
import path from "path";

export interface WorkspacePaths {
  cliDir: string;
  cliPackageJsonPath: string;
  rootDir: string;
  rootPackageJsonPath: string;
  rootPackageLockPath: string;
  nestedLockPath: string;
}

export function getWorkspacePaths(baseDir: string = __dirname): WorkspacePaths {
  const cliDir = path.resolve(baseDir, "..");
  const rootDir = path.resolve(cliDir, "..");

  return {
    cliDir,
    cliPackageJsonPath: path.join(cliDir, "package.json"),
    rootDir,
    rootPackageJsonPath: path.join(rootDir, "package.json"),
    rootPackageLockPath: path.join(rootDir, "package-lock.json"),
    nestedLockPath: path.join(cliDir, "package-lock.json"),
  };
}

export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
