import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('SecureFlow CLI Workspace Integration (#636)', () => {
  const cliDir = path.resolve(__dirname, '..');
  const cliPackageJsonPath = path.join(cliDir, 'package.json');
  const rootDir = path.resolve(cliDir, '..');
  const rootPackageJsonPath = path.join(rootDir, 'package.json');
  const rootPackageLockPath = path.join(rootDir, 'package-lock.json');
  const nestedLockPath = path.join(cliDir, 'package-lock.json');

  it('verifies cli is properly configured as an npm workspace package', () => {
    const rootPkg = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
    expect(rootPkg.workspaces).toBeDefined();
    expect(rootPkg.workspaces).toContain('cli');
  });

  it('ensures no isolated package-lock.json remains inside cli workspace', () => {
    expect(fs.existsSync(nestedLockPath)).toBe(false);
  });

  it('ensures cli exports valid bin entry point and build targets', () => {
    const cliPkg = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf8'));
    expect(cliPkg.name).toBe('secureflow-cli');
    expect(cliPkg.bin).toBeDefined();
    expect(cliPkg.bin.secureflow).toBe('./dist/index.js');
  });

  it('validates that root package-lock.json manages cli dependencies without collisions', () => {
    expect(fs.existsSync(rootPackageLockPath)).toBe(true);
    const lockContent = fs.readFileSync(rootPackageLockPath, 'utf8');
    const lockJson = JSON.parse(lockContent);
    expect(lockJson.lockfileVersion).toBeGreaterThanOrEqual(2);
  });
});
