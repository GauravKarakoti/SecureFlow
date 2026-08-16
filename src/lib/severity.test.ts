import { describe, it, expect } from 'vitest';
import {
  SEVERITY_ORDER,
  SEVERITY_RISK_WEIGHT,
  SEVERITY_BADGE,
  isSeverity,
  parseSeverity,
  normalizeSeverity,
  severityRank,
  compareSeverity,
  isAtLeast,
  riskWeight,
  severityBadge,
  maxSeverity,
  emptySeverityCounts,
  countBySeverity,
  totalRiskScore,
} from './severity';

describe('SEVERITY_ORDER', () => {
  it('is ordered most severe first', () => {
    expect([...SEVERITY_ORDER]).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']);
  });

  it('has a risk weight and a badge for every level', () => {
    for (const severity of SEVERITY_ORDER) {
      expect(SEVERITY_RISK_WEIGHT[severity]).toBeTypeOf('number');
      expect(SEVERITY_BADGE[severity]).toBeTypeOf('string');
    }
  });

  it('assigns strictly decreasing risk weights', () => {
    const weights = SEVERITY_ORDER.map((s) => SEVERITY_RISK_WEIGHT[s]);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
    }
  });
});

describe('isSeverity', () => {
  it('accepts the canonical spellings', () => {
    for (const severity of SEVERITY_ORDER) {
      expect(isSeverity(severity)).toBe(true);
    }
  });

  it('rejects non-canonical casing', () => {
    expect(isSeverity('critical')).toBe(false);
    expect(isSeverity('Critical')).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    expect(isSeverity(null)).toBe(false);
    expect(isSeverity(undefined)).toBe(false);
    expect(isSeverity(10)).toBe(false);
    expect(isSeverity({})).toBe(false);
  });
});

describe('parseSeverity', () => {
  it('passes canonical values through', () => {
    expect(parseSeverity('CRITICAL')).toBe('CRITICAL');
    expect(parseSeverity('NONE')).toBe('NONE');
  });

  it('normalizes casing — the bug that made a lowercase severity unenforceable', () => {
    expect(parseSeverity('critical')).toBe('CRITICAL');
    expect(parseSeverity('Critical')).toBe('CRITICAL');
    expect(parseSeverity('cRiTiCaL')).toBe('CRITICAL');
  });

  it('trims surrounding whitespace', () => {
    expect(parseSeverity('  HIGH  ')).toBe('HIGH');
    expect(parseSeverity('\tMEDIUM\n')).toBe('MEDIUM');
  });

  it('collapses internal separators before matching aliases', () => {
    expect(parseSeverity('sev 1')).toBe('CRITICAL');
    expect(parseSeverity('SEV-1')).toBe('CRITICAL');
    expect(parseSeverity('sev_1')).toBe('CRITICAL');
  });

  it('resolves priority-scale aliases', () => {
    expect(parseSeverity('P0')).toBe('CRITICAL');
    expect(parseSeverity('p2')).toBe('HIGH');
    expect(parseSeverity('P3')).toBe('MEDIUM');
    expect(parseSeverity('p4')).toBe('LOW');
  });

  it('resolves SARIF / linter level names', () => {
    expect(parseSeverity('error')).toBe('HIGH');
    expect(parseSeverity('warning')).toBe('MEDIUM');
    expect(parseSeverity('note')).toBe('LOW');
    expect(parseSeverity('informational')).toBe('LOW');
  });

  it('resolves the prose the model reaches for', () => {
    expect(parseSeverity('moderate')).toBe('MEDIUM');
    expect(parseSeverity('major')).toBe('HIGH');
    expect(parseSeverity('minor')).toBe('LOW');
    expect(parseSeverity('blocker')).toBe('CRITICAL');
  });

  it('returns null rather than throwing for unusable input', () => {
    expect(parseSeverity(null)).toBeNull();
    expect(parseSeverity(undefined)).toBeNull();
    expect(parseSeverity('')).toBeNull();
    expect(parseSeverity('   ')).toBeNull();
    expect(parseSeverity(42)).toBeNull();
    expect(parseSeverity({ severity: 'HIGH' })).toBeNull();
    expect(parseSeverity([])).toBeNull();
    expect(parseSeverity('probably quite bad')).toBeNull();
  });
});

describe('normalizeSeverity', () => {
  it('falls back to MEDIUM so an unrecognised finding stays enforceable', () => {
    expect(normalizeSeverity(null)).toBe('MEDIUM');
    expect(normalizeSeverity('nonsense')).toBe('MEDIUM');
  });

  it('honours an explicit fallback', () => {
    expect(normalizeSeverity(null, 'NONE')).toBe('NONE');
    expect(normalizeSeverity(undefined, 'CRITICAL')).toBe('CRITICAL');
  });

  it('never returns the fallback for a parseable value', () => {
    expect(normalizeSeverity('low', 'CRITICAL')).toBe('LOW');
  });
});

describe('severityRank / compareSeverity', () => {
  it('ranks more severe values lower', () => {
    expect(severityRank('CRITICAL')).toBeLessThan(severityRank('HIGH'));
    expect(severityRank('HIGH')).toBeLessThan(severityRank('MEDIUM'));
    expect(severityRank('LOW')).toBeLessThan(severityRank('NONE'));
  });

  it('ranks unparseable input last so it cannot sort to the top', () => {
    expect(severityRank('bogus')).toBeGreaterThan(severityRank('NONE'));
    expect(severityRank(null)).toBeGreaterThan(severityRank('NONE'));
  });

  it('sorts a findings list most severe first', () => {
    const findings = [
      { severity: 'low' },
      { severity: 'CRITICAL' },
      { severity: null },
      { severity: 'medium' },
      { severity: 'HIGH' },
    ];

    const sorted = [...findings].sort((a, b) => compareSeverity(a.severity, b.severity));

    expect(sorted.map((f) => f.severity)).toEqual(['CRITICAL', 'HIGH', 'medium', 'low', null]);
  });
});

describe('isAtLeast', () => {
  it('is inclusive of the threshold', () => {
    expect(isAtLeast('HIGH', 'HIGH')).toBe(true);
  });

  it('matches more severe values', () => {
    expect(isAtLeast('CRITICAL', 'HIGH')).toBe(true);
  });

  it('rejects less severe values', () => {
    expect(isAtLeast('MEDIUM', 'HIGH')).toBe(false);
    expect(isAtLeast('NONE', 'LOW')).toBe(false);
  });

  it('applies normalization before comparing', () => {
    expect(isAtLeast('critical', 'HIGH')).toBe(true);
    expect(isAtLeast('  error ', 'HIGH')).toBe(true);
  });

  it('is false for unparseable input', () => {
    expect(isAtLeast(null, 'NONE')).toBe(false);
    expect(isAtLeast('bogus', 'NONE')).toBe(false);
  });
});

describe('riskWeight', () => {
  it('uses the shared weight table', () => {
    expect(riskWeight('CRITICAL')).toBe(10);
    expect(riskWeight('HIGH')).toBe(5);
    expect(riskWeight('MEDIUM')).toBe(3);
    expect(riskWeight('LOW')).toBe(1);
    expect(riskWeight('NONE')).toBe(0);
  });

  it('scores a lowercase critical as 10, not 0', () => {
    expect(riskWeight('critical')).toBe(10);
  });

  it('scores unparseable input as 0 without throwing', () => {
    expect(riskWeight(null)).toBe(0);
    expect(riskWeight(undefined)).toBe(0);
    expect(riskWeight('bogus')).toBe(0);
  });
});

describe('severityBadge', () => {
  it('renders each level distinctly', () => {
    const badges = SEVERITY_ORDER.map((s) => severityBadge(s));
    expect(new Set(badges).size).toBe(SEVERITY_ORDER.length);
  });

  it('no longer mislabels LOW and NONE as MEDIUM', () => {
    expect(severityBadge('LOW')).toContain('LOW');
    expect(severityBadge('NONE')).toContain('NONE');
    expect(severityBadge('LOW')).not.toContain('MEDIUM');
  });

  it('renders unparseable input as NONE rather than throwing', () => {
    expect(severityBadge(null)).toBe(SEVERITY_BADGE.NONE);
  });
});

describe('maxSeverity', () => {
  it('returns the most severe entry', () => {
    expect(maxSeverity(['LOW', 'CRITICAL', 'MEDIUM'])).toBe('CRITICAL');
    expect(maxSeverity(['low', 'medium'])).toBe('MEDIUM');
  });

  it('skips unparseable entries', () => {
    expect(maxSeverity([null, 'bogus', 'high'])).toBe('HIGH');
  });

  it('returns null for an empty or wholly unparseable list', () => {
    expect(maxSeverity([])).toBeNull();
    expect(maxSeverity([null, undefined, 'bogus'])).toBeNull();
  });
});

describe('countBySeverity', () => {
  it('starts from a zeroed map with every key present', () => {
    expect(countBySeverity([])).toEqual(emptySeverityCounts());
    expect(Object.keys(countBySeverity([])).sort()).toEqual([...SEVERITY_ORDER].sort());
  });

  it('reads the severity property by default', () => {
    const counts = countBySeverity([
      { severity: 'CRITICAL' },
      { severity: 'critical' },
      { severity: 'HIGH' },
    ]);

    expect(counts.CRITICAL).toBe(2);
    expect(counts.HIGH).toBe(1);
    expect(counts.LOW).toBe(0);
  });

  it('accepts a custom accessor', () => {
    const counts = countBySeverity([{ level: 'p1' }, { level: 'p4' }], (item) => item.level);
    expect(counts.CRITICAL).toBe(1);
    expect(counts.LOW).toBe(1);
  });

  it('skips items with no usable severity instead of inventing a bucket', () => {
    const counts = countBySeverity([{ severity: null }, { severity: 'bogus' }, {}]);
    expect(counts).toEqual(emptySeverityCounts());
  });

  it('returns a fresh object each call', () => {
    const a = emptySeverityCounts();
    a.CRITICAL = 5;
    expect(emptySeverityCounts().CRITICAL).toBe(0);
  });
});

describe('totalRiskScore', () => {
  it('sums the shared weights', () => {
    const score = totalRiskScore([
      { severity: 'CRITICAL' },
      { severity: 'HIGH' },
      { severity: 'LOW' },
    ]);
    expect(score).toBe(16);
  });

  it('counts a lowercase critical, which previously scored 0', () => {
    expect(totalRiskScore([{ severity: 'critical' }])).toBe(10);
  });

  it('survives a null severity that previously threw a TypeError', () => {
    expect(() => totalRiskScore([{ severity: null }])).not.toThrow();
    expect(totalRiskScore([{ severity: null }, { severity: 'HIGH' }])).toBe(5);
  });

  it('is 0 for an empty list', () => {
    expect(totalRiskScore([])).toBe(0);
  });
});
