/**
 * Tests for the finding taxonomy (#590).
 *
 * The cases that matter most are the ones the dashboard used to count as zero:
 * a lowercase `"secret"`, an `"Injection"` that belongs in no hand-written list,
 * and every legacy spelling the two pages enumerated by hand — those have to
 * keep counting exactly as they did or the fix quietly changes historical
 * numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABEL,
  FINDING_CATEGORY_TITLE,
  findingCategoryFilter,
  findingTypeSpellings,
  isFindingCategory,
  normalizeFindingType,
  normalizeFindingTypeLabel,
  parseFindingType,
  severityFilter,
} from './finding-taxonomy';
import { parseSeverity, severitySpellings, SEVERITY_ORDER } from './severity';

describe('parseFindingType — canonical names', () => {
  it.each(FINDING_CATEGORIES)('recognises %s', (category) => {
    expect(parseFindingType(category)).toBe(category);
  });

  it('recognises the stored label for each category', () => {
    for (const category of FINDING_CATEGORIES) {
      expect(parseFindingType(FINDING_CATEGORY_LABEL[category])).toBe(category);
    }
  });
});

describe('parseFindingType — the spellings the dashboard used to enumerate', () => {
  // These are the exact strings the two pages carried in their `type: { in: [] }`
  // lists. They must keep classifying the same way, or historical counts move.
  it.each([
    ['Secret', 'SECRET'],
    ['Hardcoded Secret', 'SECRET'],
    ['Data Leak', 'SECRET'],
    ['Contextual Leak', 'SECRET'],
    ['Vulnerability', 'VULNERABILITY'],
    ['Logic Flaw', 'VULNERABILITY'],
    ['Misconfig', 'MISCONFIG'],
    ['Potential Misconfig', 'MISCONFIG'],
  ] as const)('%s -> %s', (raw, expected) => {
    expect(parseFindingType(raw)).toBe(expected);
  });
});

describe('parseFindingType — casing and separators', () => {
  it.each(['secret', 'SECRET', 'Secret', '  secret  ', 'hardcoded_secret', 'HARDCODED-SECRET', 'Hardcoded Secret'])(
    'classifies %j as a secret',
    (raw) => {
      expect(parseFindingType(raw)).toBe('SECRET');
    },
  );

  it('collapses slashes and dots too', () => {
    expect(parseFindingType('api.key')).toBe('SECRET');
    expect(parseFindingType('path/traversal')).toBe('VULNERABILITY');
  });
});

describe('parseFindingType — the keyword fallback', () => {
  it('classifies a phrasing that is in no alias list', () => {
    // The concrete miss from the issue: counted in no tile at all, while being
    // rendered in the table underneath.
    expect(parseFindingType('Injection')).toBe('VULNERABILITY');
    expect(parseFindingType('SQL Injection Vulnerability')).toBe('VULNERABILITY');
    expect(parseFindingType('Reflected Cross-Site Scripting')).toBe('VULNERABILITY');
  });

  it('prefers the secret reading when a phrase could be read two ways', () => {
    // Ordering is load-bearing: a hardcoded credential that happens to live in
    // a config file is a secret, not a misconfiguration.
    expect(parseFindingType('Hardcoded credential in an insecure config')).toBe('SECRET');
  });

  it('classifies unfamiliar misconfiguration phrasings', () => {
    expect(parseFindingType('Missing Content-Security-Policy header')).toBe('MISCONFIG');
    expect(parseFindingType('Weak cipher suite')).toBe('MISCONFIG');
  });

  it('does not match on a fragment of an ordinary word', () => {
    // The failure mode this fallback has to avoid: `filterFalsePositives` drops
    // any schema finding whose snippet contains "int", which also matches
    // "print", "point" and "integrity".
    expect(parseFindingType('Print statement')).toBeNull();
    expect(parseFindingType('Integrity check')).toBeNull();
  });
});

describe('parseFindingType — totality', () => {
  it.each([null, undefined, 42, {}, [], Symbol('x'), true, NaN])(
    'returns null rather than throwing for %j',
    (input) => {
      expect(() => parseFindingType(input)).not.toThrow();
      expect(parseFindingType(input)).toBeNull();
    },
  );

  it('returns null for whitespace and for a string of only separators', () => {
    expect(parseFindingType('   ')).toBeNull();
    expect(parseFindingType('-_-')).toBeNull();
  });
});

describe('normalizeFindingType', () => {
  it('falls back to OTHER, not to VULNERABILITY', () => {
    // The scanner's old `String(f.type || 'Vulnerability')` made an
    // unclassifiable finding indistinguishable from one the model actually
    // called a vulnerability, quietly inflating that tile.
    expect(normalizeFindingType(undefined)).toBe('OTHER');
    expect(normalizeFindingType('something nobody has ever written')).toBe('OTHER');
  });

  it('produces a stable stored label', () => {
    expect(normalizeFindingTypeLabel('hardcoded_secret')).toBe('Secret');
    expect(normalizeFindingTypeLabel('SQL Injection')).toBe('Vulnerability');
    expect(normalizeFindingTypeLabel('')).toBe('Other');
  });

  it('is idempotent — normalising a label again gives the same label', () => {
    for (const category of FINDING_CATEGORIES) {
      const once = normalizeFindingTypeLabel(FINDING_CATEGORY_LABEL[category]);
      expect(normalizeFindingTypeLabel(once)).toBe(once);
    }
  });
});

describe('isFindingCategory', () => {
  it('accepts canonical categories and rejects labels', () => {
    expect(isFindingCategory('SECRET')).toBe(true);
    expect(isFindingCategory('Secret')).toBe(false);
    expect(isFindingCategory(null)).toBe(false);
  });
});

describe('findingTypeSpellings', () => {
  it('includes the stored label first-class', () => {
    expect(findingTypeSpellings('SECRET')).toContain('Secret');
    expect(findingTypeSpellings('MISCONFIG')).toContain('Misconfig');
  });

  it('round-trips: every spelling it returns classifies back to that category', () => {
    for (const category of FINDING_CATEGORIES) {
      for (const spelling of findingTypeSpellings(category)) {
        expect(parseFindingType(spelling)).toBe(category);
      }
    }
  });

  it('returns nothing for OTHER, which is defined by exclusion', () => {
    expect(findingTypeSpellings('OTHER')).toEqual([]);
  });

  it('never assigns the same spelling to two categories', () => {
    const seen = new Map<string, string>();
    for (const category of FINDING_CATEGORIES) {
      for (const spelling of findingTypeSpellings(category)) {
        expect(seen.get(spelling) ?? category).toBe(category);
        seen.set(spelling, category);
      }
    }
  });
});

describe('findingCategoryFilter', () => {
  it('builds a case-insensitive `in` filter for a classified category', () => {
    const filter = findingCategoryFilter('VULNERABILITY');

    expect(filter).toMatchObject({ mode: 'insensitive' });
    expect('in' in filter && filter.in).toContain('Vulnerability');
  });

  it('builds OTHER as the negation of the other three', () => {
    const filter = findingCategoryFilter('OTHER');

    expect(filter).toMatchObject({ mode: 'insensitive' });
    expect('notIn' in filter && filter.notIn).toEqual(
      expect.arrayContaining([
        ...findingTypeSpellings('SECRET'),
        ...findingTypeSpellings('VULNERABILITY'),
        ...findingTypeSpellings('MISCONFIG'),
      ]),
    );
  });

  it('partitions: OTHER excludes exactly what the three categories include', () => {
    const filter = findingCategoryFilter('OTHER');
    const excluded = new Set('notIn' in filter ? filter.notIn : []);
    const classified = new Set(
      (['SECRET', 'VULNERABILITY', 'MISCONFIG'] as const).flatMap(findingTypeSpellings),
    );

    expect([...excluded].sort()).toEqual([...classified].sort());
  });
});

describe('severityFilter', () => {
  it('matches case-insensitively rather than by exact string', () => {
    const filter = severityFilter('CRITICAL');

    expect(filter.mode).toBe('insensitive');
    expect(filter.in).toContain('CRITICAL');
  });

  it('covers the aliases parseSeverity already understands', () => {
    // The point of deriving from severity.ts rather than hand-listing: what the
    // tiles count has to agree with what the policy engine enforces.
    const filter = severityFilter('CRITICAL');

    expect(filter.in).toEqual(expect.arrayContaining(['CRITICAL', 'SEV1', 'BLOCKER', 'FATAL']));
  });

  it.each(SEVERITY_ORDER)('every spelling for %s parses back to it', (level) => {
    for (const spelling of severitySpellings(level)) {
      expect(parseSeverity(spelling)).toBe(level);
    }
  });

  it('assigns each alias to exactly one level', () => {
    const seen = new Set<string>();
    for (const level of SEVERITY_ORDER) {
      for (const spelling of severitySpellings(level)) {
        expect(seen.has(spelling)).toBe(false);
        seen.add(spelling);
      }
    }
  });
});

describe('display metadata', () => {
  it('has a label and a title for every category', () => {
    for (const category of FINDING_CATEGORIES) {
      expect(FINDING_CATEGORY_LABEL[category]).toBeTruthy();
      expect(FINDING_CATEGORY_TITLE[category]).toBeTruthy();
    }
  });
});
