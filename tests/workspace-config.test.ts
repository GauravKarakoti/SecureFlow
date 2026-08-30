import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('npm workspaces and lockfile configuration (#636)', () => {
  const rootDir = process.cwd();
  const rootPackageJsonPath = path.join(rootDir, 'package.json');
  const rootPackageLockPath = path.join(rootDir, 'package-lock.json');
  const cliDir = path.join(rootDir, 'cli');
  const cliPackageJsonPath = path.join(cliDir, 'package.json');
  const cliPackageLockPath = path.join(cliDir, 'package-lock.json');

  it('declares workspaces in root package.json including the cli package', () => {
    expect(fs.existsSync(rootPackageJsonPath)).toBe(true);
    const rootPkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));

    expect(rootPkg).toHaveProperty('workspaces');
    expect(Array.isArray(rootPkg.workspaces)).toBe(true);
    expect(rootPkg.workspaces).toContain('cli');
  });

  it('maintains a single source of truth for the lockfile at repository root', () => {
    expect(fs.existsSync(rootPackageLockPath)).toBe(true);
    // cli/package-lock.json must be removed in favor of root package-lock.json
    expect(fs.existsSync(cliPackageLockPath)).toBe(false);
  });

  it('includes workspace packages within root package-lock.json', () => {
    const rootLock = JSON.parse(fs.readFileSync(rootPackageLockPath, 'utf8'));
    expect(rootLock).toHaveProperty('packages');
    
    // In npm workspaces, packages['cli'] or packages['node_modules/secureflow-cli'] is defined
    const hasCliPackage = Boolean(
      rootLock.packages['cli'] || rootLock.packages['node_modules/secureflow-cli']
    );
    expect(hasCliPackage).toBe(true);
  });

  it('defines valid package metadata and workspace commands in root scripts', () => {
    const rootPkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
    expect(rootPkg.scripts).toHaveProperty('cli:build');
    expect(rootPkg.scripts).toHaveProperty('cli:test');
    expect(rootPkg.scripts['cli:build']).toContain('--workspace=cli');
    expect(rootPkg.scripts['cli:test']).toContain('--workspace=cli');
  });

  it('validates cli package.json structure and compatibility with workspaces', () => {
    expect(fs.existsSync(cliPackageJsonPath)).toBe(true);
    const cliPkg = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf8'));

    expect(cliPkg.name).toBe('secureflow-cli');
    expect(cliPkg.version).toBeDefined();
    expect(cliPkg.scripts).toHaveProperty('build');
    expect(cliPkg.scripts).toHaveProperty('test');
  });

  it('prevents accidental introduction of nested package-lock files in any subdirectory', () => {
    const findNestedLockfiles = (dir: string): string[] => {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === '.next' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findNestedLockfiles(fullPath));
        } else if (entry.name === 'package-lock.json' && fullPath !== rootPackageLockPath) {
          results.push(fullPath);
        }
      }

      return results;
    };

    const nestedLocks = findNestedLockfiles(rootDir);
    expect(nestedLocks).toEqual([]);
  });
});
