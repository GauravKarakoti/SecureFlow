import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface WorkspacePaths {
  cliDir: string;
  cliPackageJsonPath: string;
  rootDir: string;
  rootPackageJsonPath: string;
  rootPackageLockPath: string;
  nestedLockPath: string;
}

// __dirname does not exist in the ESM build this package ships ("type":
// "module"), so derive the default from import.meta.url instead.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function getWorkspacePaths(baseDir: string = moduleDir): WorkspacePaths {
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
