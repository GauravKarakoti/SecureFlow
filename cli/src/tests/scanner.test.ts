import { describe, it, expect } from 'vitest';
import {
  shouldScanFile,
  looksBinary,
  maskStringLiterals,
  readArgumentList,
  lineOf,
  findSecretLogging,
  scanFile,
  MAX_SCANNED_BYTES,
} from '../scanner.js';

describe('shouldScanFile', () => {
  it('returns false for binary extensions', () => {
    expect(shouldScanFile('image.png')).toBe(false);
    expect(shouldScanFile('font.woff2')).toBe(false);
    expect(shouldScanFile('archive.zip')).toBe(false);
  });

  it('returns false for generated lock files', () => {
    expect(shouldScanFile('package-lock.json')).toBe(false);
    expect(shouldScanFile('yarn.lock')).toBe(false);
    expect(shouldScanFile('pnpm-lock.yaml')).toBe(false);
  });

  it('returns false when byteLength exceeds MAX_SCANNED_BYTES', () => {
    expect(shouldScanFile('src/index.ts', MAX_SCANNED_BYTES + 1)).toBe(false);
  });

  it('returns true for normal source files', () => {
    expect(shouldScanFile('src/index.ts')).toBe(true);
    expect(shouldScanFile('src/index.ts', 100)).toBe(true);
  });

  it('returns true at exactly MAX_SCANNED_BYTES', () => {
    expect(shouldScanFile('src/index.ts', MAX_SCANNED_BYTES)).toBe(true);
  });

  it('handles nested paths for generated files', () => {
    expect(shouldScanFile('some/nested/yarn.lock')).toBe(false);
  });
});

describe('looksBinary', () => {
  it('returns true when content contains NUL byte', () => {
    expect(looksBinary('hello\u0000world')).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(looksBinary('const x = 1;')).toBe(false);
  });
});

describe('maskStringLiterals', () => {
  it('masks double-quoted string contents', () => {
    const result = maskStringLiterals('const x = "secret";');
    expect(result).not.toContain('secret');
    expect(result).toContain('"');
  });

  it('masks single-quoted string contents', () => {
    const result = maskStringLiterals("const x = 'password';");
    expect(result).not.toContain('password');
  });

  it('preserves template literal interpolations', () => {
    const result = maskStringLiterals('console.log(`token: ${authToken}`)');
    expect(result).toContain('authToken');
  });

  it('masks line comments', () => {
    const result = maskStringLiterals('const x = 1; // secret comment');
    expect(result).not.toContain('secret');
  });

  it('masks block comments', () => {
    const result = maskStringLiterals('/* secret */ const x = 1;');
    expect(result).not.toContain('secret');
  });

  it('handles escaped quotes inside strings', () => {
    const result = maskStringLiterals('const x = "he said \\"hello\\"";');
    expect(result).not.toContain('hello');
  });

  it('handles unterminated string (stops at newline)', () => {
    // Should not throw
    expect(() => maskStringLiterals('const x = "unterminated\nconst y = 1;')).not.toThrow();
  });

  it('handles multiline template literals', () => {
    const result = maskStringLiterals('const x = `line1\nline2`;');
    expect(result).not.toContain('line1');
  });
});

describe('readArgumentList', () => {
  it('returns the argument list between parentheses', () => {
    const src = 'console.log(process.env.SECRET)';
    const openParen = src.indexOf('(');
    expect(readArgumentList(src, openParen)).toBe('process.env.SECRET');
  });

  it('handles nested parentheses', () => {
    const src = 'console.log(fn(a, b), c)';
    const openParen = src.indexOf('(');
    expect(readArgumentList(src, openParen)).toBe('fn(a, b), c');
  });

  it('returns null for unclosed parenthesis', () => {
    const src = 'console.log(process.env.SECRET';
    expect(readArgumentList(src, src.indexOf('('))).toBeNull();
  });
});

describe('lineOf', () => {
  it('returns 1 for offset 0', () => {
    expect(lineOf('hello\nworld', 0)).toBe(1);
  });

  it('returns 2 for offset after first newline', () => {
    expect(lineOf('hello\nworld', 6)).toBe(2);
  });

  it('handles offset beyond source length', () => {
    expect(lineOf('hello', 100)).toBe(1);
  });
});

describe('findSecretLogging', () => {
  it('returns empty array for empty string', () => {
    expect(findSecretLogging('')).toEqual([]);
  });

  it('detects process.env logging', () => {
    const violations = findSecretLogging('console.log(process.env.SECRET_KEY);');
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe('environment variable');
  });

  it('detects secret-named identifier', () => {
    const violations = findSecretLogging('console.log(userPassword);');
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe('secret-named identifier');
  });

  it('detects api key patterns', () => {
    const violations = findSecretLogging('console.error(apiKey);');
    expect(violations).toHaveLength(1);
  });

  it('does not flag safe console calls', () => {
    expect(findSecretLogging('console.log("hello world");')).toHaveLength(0);
  });

  it('does not flag string literals containing secret words', () => {
    expect(findSecretLogging('console.log("the password is safe here");')).toHaveLength(0);
  });

  it('detects multiline console calls', () => {
    const src = 'console.log(\n  process.env.DB_PASSWORD\n);';
    const violations = findSecretLogging(src);
    expect(violations).toHaveLength(1);
  });

  it('reports correct line number', () => {
    const src = 'const x = 1;\nconsole.log(process.env.TOKEN);';
    const violations = findSecretLogging(src);
    expect(violations[0].line).toBe(2);
  });

  it('detects import.meta.env', () => {
    const violations = findSecretLogging('console.log(import.meta.env.VITE_SECRET);');
    expect(violations).toHaveLength(1);
  });

  it('handles unclosed parenthesis gracefully', () => {
    expect(() => findSecretLogging('console.log(process.env.SECRET')).not.toThrow();
  });
});

describe('scanFile', () => {
  it('skips binary-extension files', () => {
    const result = scanFile('image.png', 'data');
    expect(result.skipped).toBe('excluded by type or size');
    expect(result.violations).toHaveLength(0);
  });

  it('skips binary content', () => {
    const result = scanFile('src/index.ts', 'data\u0000binary');
    expect(result.skipped).toBe('binary content');
  });

  it('returns violations for secret logging', () => {
    const result = scanFile('src/index.ts', 'console.log(process.env.SECRET);');
    expect(result.violations).toHaveLength(1);
    expect(result.skipped).toBeUndefined();
  });

  it('returns no violations for clean file', () => {
    const result = scanFile('src/index.ts', 'const x = 1;');
    expect(result.violations).toHaveLength(0);
    expect(result.skipped).toBeUndefined();
  });
});
