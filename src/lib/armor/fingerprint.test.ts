import { describe, it, expect } from 'vitest';
import { computeFingerprint } from './fingerprint';

describe('computeFingerprint', () => {
  const base = () => computeFingerprint('repo-1', 'src/app.ts', 'Secret', 'const k = "abc"');

  it('produces a stable 64-char sha256 hex digest', () => {
    const fp = base();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(base()).toBe(base());
  });

  it('stays stable when only line numbers move (line numbers are not an input)', () => {
    // Same repo/file/type/snippet — a finding that merely shifts in the file
    // must keep the same fingerprint so its triage survives.
    const a = computeFingerprint('repo-1', 'src/app.ts', 'Secret', 'const k = "abc"');
    const b = computeFingerprint('repo-1', 'src/app.ts', 'Secret', 'const k = "abc"');
    expect(a).toBe(b);
  });

  it('changes when the repository differs', () => {
    expect(base()).not.toBe(
      computeFingerprint('repo-2', 'src/app.ts', 'Secret', 'const k = "abc"')
    );
  });

  it('changes when the file location differs', () => {
    expect(base()).not.toBe(
      computeFingerprint('repo-1', 'src/other.ts', 'Secret', 'const k = "abc"')
    );
  });

  it('changes when the finding type differs', () => {
    expect(base()).not.toBe(
      computeFingerprint('repo-1', 'src/app.ts', 'Vulnerability', 'const k = "abc"')
    );
  });

  it('changes when the code snippet differs', () => {
    expect(base()).not.toBe(
      computeFingerprint('repo-1', 'src/app.ts', 'Secret', 'const k = "xyz"')
    );
  });

  it('treats null and undefined snippets the same as an empty snippet', () => {
    const withNull = computeFingerprint('repo-1', 'src/app.ts', 'Secret', null);
    const withUndefined = computeFingerprint('repo-1', 'src/app.ts', 'Secret', undefined);
    const withEmpty = computeFingerprint('repo-1', 'src/app.ts', 'Secret', '');
    expect(withNull).toBe(withUndefined);
    expect(withNull).toBe(withEmpty);
  });

  it('does not collide across field boundaries', () => {
    // Concatenating fields naively (no separator) could let one field bleed
    // into the next; the separated inputs must stay distinct.
    const a = computeFingerprint('repo', '1src', 'Secret', 'x');
    const b = computeFingerprint('repo1', 'src', 'Secret', 'x');
    expect(a).not.toBe(b);
  });
});
