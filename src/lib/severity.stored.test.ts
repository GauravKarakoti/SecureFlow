import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SEVERITY_ORDER,
  STORED_SEVERITIES,
  emptyStoredSeverityCounts,
  isStoredSeverity,
  normalizeSeverity,
  parseStoredSeverity,
  storedSeverityRank,
  toStoredSeverity,
  type StoredSeverity,
} from './severity';

/**
 * The storage vocabulary (#686).
 *
 * The bug this covers was not a wrong value anywhere — it was two lists that
 * looked like the same list. So the first test here reads the Prisma schema and
 * asserts they still agree, because a future migration that adds an enum member
 * without touching this file reintroduces the whole failure class silently.
 */
describe('STORED_SEVERITIES matches the FindingSeverity enum', () => {
  function enumMembers(name: string): string[] {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf-8');
    const match = schema.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
    expect(match, `enum ${name} not found in prisma/schema.prisma`).toBeTruthy();

    return (match![1].match(/[A-Z_][A-Z0-9_]*/g) ?? []).filter(Boolean);
  }

  it('holds exactly the members the database declares', () => {
    expect([...STORED_SEVERITIES].sort()).toEqual(enumMembers('FindingSeverity').sort());
  });

  it('is not the same list as the ranking vocabulary', () => {
    // The regression guard. If these ever become equal, either the schema
    // gained NONE or SEVERITY_ORDER lost it, and the mapping below is stale.
    expect([...STORED_SEVERITIES]).not.toEqual([...SEVERITY_ORDER]);
    expect(SEVERITY_ORDER).toContain('NONE');
    expect(STORED_SEVERITIES).not.toContain('NONE' as StoredSeverity);
    expect(STORED_SEVERITIES).toContain('INFO');
  });

  it('orders most severe first', () => {
    expect([...STORED_SEVERITIES]).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
  });
});

describe('isStoredSeverity', () => {
  it('accepts every enum member', () => {
    for (const level of STORED_SEVERITIES) {
      expect(isStoredSeverity(level)).toBe(true);
    }
  });

  it('rejects NONE, which the column cannot hold', () => {
    expect(isStoredSeverity('NONE')).toBe(false);
  });

  it('rejects lower-case spellings and non-strings', () => {
    expect(isStoredSeverity('critical')).toBe(false);
    expect(isStoredSeverity(null)).toBe(false);
    expect(isStoredSeverity(undefined)).toBe(false);
    expect(isStoredSeverity(3)).toBe(false);
    expect(isStoredSeverity({ severity: 'HIGH' })).toBe(false);
  });
});

describe('parseStoredSeverity', () => {
  it('passes canonical members through', () => {
    for (const level of STORED_SEVERITIES) {
      expect(parseStoredSeverity(level)).toBe(level);
    }
  });

  it('is case- and separator-insensitive', () => {
    expect(parseStoredSeverity('critical')).toBe('CRITICAL');
    expect(parseStoredSeverity('  High  ')).toBe('HIGH');
    expect(parseStoredSeverity('info')).toBe('INFO');
  });

  it('maps the ranking level NONE onto INFO rather than dropping it', () => {
    expect(parseStoredSeverity('NONE')).toBe('INFO');
    expect(parseStoredSeverity('none')).toBe('INFO');
  });

  it('maps the scanner "nothing found" words onto INFO', () => {
    for (const word of ['clean', 'pass', 'ok', 'unknown']) {
      expect(parseStoredSeverity(word)).toBe('INFO');
    }
  });

  it('keeps informational spellings in INFO instead of folding them into LOW', () => {
    // normalizeSeverity folds these into LOW, which is right for ranking and
    // wrong for storage: the enum has a dedicated member for them.
    for (const word of ['info', 'informational', 'notice', 'note']) {
      expect(normalizeSeverity(word)).toBe('LOW');
      expect(parseStoredSeverity(word)).toBe('INFO');
    }
  });

  it('resolves the ranking aliases through to an enum member', () => {
    expect(parseStoredSeverity('sev1')).toBe('CRITICAL');
    expect(parseStoredSeverity('P0')).toBe('CRITICAL');
    expect(parseStoredSeverity('blocker')).toBe('CRITICAL');
    expect(parseStoredSeverity('error')).toBe('HIGH');
    expect(parseStoredSeverity('warning')).toBe('MEDIUM');
    expect(parseStoredSeverity('minor')).toBe('LOW');
  });

  it('returns null for values that mean nothing', () => {
    expect(parseStoredSeverity('')).toBeNull();
    expect(parseStoredSeverity('   ')).toBeNull();
    expect(parseStoredSeverity('banana')).toBeNull();
    expect(parseStoredSeverity(null)).toBeNull();
    expect(parseStoredSeverity(undefined)).toBeNull();
    expect(parseStoredSeverity(7)).toBeNull();
  });

  it('never returns a value the enum rejects', () => {
    const inputs = [
      'CRITICAL', 'critical', 'none', 'NONE', 'clean', 'pass', 'ok', 'unknown',
      'info', 'informational', 'sev0', 'sev4', 'p3', 'warn', 'trivial', 'major',
    ];

    for (const input of inputs) {
      const result = parseStoredSeverity(input);
      expect(result, input).not.toBeNull();
      expect(STORED_SEVERITIES, input).toContain(result!);
    }
  });
});

describe('toStoredSeverity', () => {
  it('falls back to MEDIUM so an unrecognised finding stays in enforcement', () => {
    expect(toStoredSeverity('banana')).toBe('MEDIUM');
    expect(toStoredSeverity(null)).toBe('MEDIUM');
    expect(toStoredSeverity(undefined)).toBe('MEDIUM');
  });

  it('honours an explicit fallback', () => {
    expect(toStoredSeverity('banana', 'INFO')).toBe('INFO');
    expect(toStoredSeverity(undefined, 'CRITICAL')).toBe('CRITICAL');
  });

  it('never yields NONE, which normalizeSeverity can', () => {
    // This is the write-path bug: worker.ts persisted normalizeSeverity(...)
    // straight into the enum column.
    for (const word of ['clean', 'pass', 'ok', 'unknown']) {
      expect(normalizeSeverity(word)).toBe('NONE');
      expect(toStoredSeverity(word)).toBe('INFO');
      expect(isStoredSeverity(toStoredSeverity(word))).toBe(true);
    }
  });
});

describe('storedSeverityRank', () => {
  it('ranks most severe lowest', () => {
    expect(storedSeverityRank('CRITICAL')).toBeLessThan(storedSeverityRank('HIGH'));
    expect(storedSeverityRank('HIGH')).toBeLessThan(storedSeverityRank('MEDIUM'));
    expect(storedSeverityRank('MEDIUM')).toBeLessThan(storedSeverityRank('LOW'));
    expect(storedSeverityRank('LOW')).toBeLessThan(storedSeverityRank('INFO'));
  });

  it('sorts unparseable values last', () => {
    expect(storedSeverityRank('banana')).toBeGreaterThan(storedSeverityRank('INFO'));
    expect(storedSeverityRank(null)).toBe(STORED_SEVERITIES.length);
  });

  it('sorts a mixed list correctly', () => {
    const sorted = ['INFO', 'CRITICAL', 'LOW', 'HIGH', 'MEDIUM'].sort(
      (a, b) => storedSeverityRank(a) - storedSeverityRank(b)
    );
    expect(sorted).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
  });
});

describe('emptyStoredSeverityCounts', () => {
  it('has a key for every enum member and nothing else', () => {
    expect(Object.keys(emptyStoredSeverityCounts()).sort()).toEqual([...STORED_SEVERITIES].sort());
  });

  it('starts at zero and is a fresh object each call', () => {
    const first = emptyStoredSeverityCounts();
    first.CRITICAL += 5;
    expect(emptyStoredSeverityCounts().CRITICAL).toBe(0);
  });
});
