import { describe, it, expect } from 'vitest';
import { parseArgs, formatFinding } from '../index.js';

describe('parseArgs', () => {
  it('parses a flag with a value', () => {
    expect(parseArgs(['--repo', 'my-repo'])).toEqual({ repo: 'my-repo' });
  });

  it('parses a boolean flag', () => {
    expect(parseArgs(['--verbose'])).toEqual({ verbose: true });
  });

  it('parses multiple flags', () => {
    expect(parseArgs(['--repo', 'my-repo', '--verbose'])).toEqual({
      repo: 'my-repo',
      verbose: true,
    });
  });

  it('returns empty object for no args', () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe('formatFinding', () => {
  it('formats a finding with a line number', () => {
    expect(
      formatFinding({ type: 'SQL_INJECTION', severity: 'HIGH', file: 'db.ts', line: 42 })
    ).toBe('[HIGH] SQL_INJECTION — db.ts:42');
  });

  it('formats a finding without a line number', () => {
    expect(
      formatFinding({ type: 'HARDCODED_SECRET', severity: 'CRITICAL', file: 'config.ts' })
    ).toBe('[CRITICAL] HARDCODED_SECRET — config.ts');
  });
});
