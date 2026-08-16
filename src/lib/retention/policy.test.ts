import { describe, it, expect } from 'vitest';
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_RULES,
  RetentionConfigError,
  parseRetentionDays,
  resolveRetentionPolicy,
  retentionFor,
} from './policy';

const auditRule = RETENTION_RULES.find((r) => r.target === 'auditLog')!;

describe('RETENTION_RULES', () => {
  it('covers every table that grows without bound', () => {
    expect(RETENTION_RULES.map((r) => r.target).sort()).toEqual([
      'auditLog',
      'findingSnippet',
      'scanResult',
      'webhookEvent',
    ]);
  });

  it('gives every rule a variable, a default and a rationale', () => {
    for (const rule of RETENTION_RULES) {
      expect(rule.envVar).toMatch(/^[A-Z_]+$/);
      expect(rule.defaultDays).toBeGreaterThanOrEqual(MIN_RETENTION_DAYS);
      expect(rule.defaultDays).toBeLessThanOrEqual(MAX_RETENTION_DAYS);
      expect(rule.rationale.length).toBeGreaterThan(20);
    }
  });

  it('uses a unique variable per rule', () => {
    const vars = RETENTION_RULES.map((r) => r.envVar);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('expires the code snippet sooner than the scan that produced it', () => {
    // The point of the split: keep the security history, drop the copied source.
    const snippet = RETENTION_RULES.find((r) => r.target === 'findingSnippet')!;
    const scan = RETENTION_RULES.find((r) => r.target === 'scanResult')!;
    expect(snippet.defaultDays).toBeLessThan(scan.defaultDays);
  });
});

describe('parseRetentionDays', () => {
  it('uses the default when the variable is unset', () => {
    expect(parseRetentionDays(auditRule, undefined)).toBe(auditRule.defaultDays);
    expect(parseRetentionDays(auditRule, '')).toBe(auditRule.defaultDays);
    expect(parseRetentionDays(auditRule, '   ')).toBe(auditRule.defaultDays);
  });

  it('honours a valid override', () => {
    expect(parseRetentionDays(auditRule, '30')).toBe(30);
    expect(parseRetentionDays(auditRule, ' 90 ')).toBe(90);
  });

  it('throws on a non-numeric value rather than silently keeping the default', () => {
    // Someone tried to configure this and got it wrong. Retaining for the
    // default period instead of the intended one is the failure this module
    // exists to prevent.
    expect(() => parseRetentionDays(auditRule, 'forever')).toThrow(RetentionConfigError);
    expect(() => parseRetentionDays(auditRule, '30d')).toThrow(RetentionConfigError);
  });

  it('throws on a fractional value', () => {
    expect(() => parseRetentionDays(auditRule, '1.5')).toThrow(RetentionConfigError);
  });

  it('rejects a window of zero, which would purge rows as they are written', () => {
    expect(() => parseRetentionDays(auditRule, '0')).toThrow(RetentionConfigError);
  });

  it('rejects a negative window', () => {
    expect(() => parseRetentionDays(auditRule, '-1')).toThrow(RetentionConfigError);
  });

  it('rejects an absurdly long window as a probable typo', () => {
    expect(() => parseRetentionDays(auditRule, String(MAX_RETENTION_DAYS + 1))).toThrow(
      RetentionConfigError
    );
  });

  it('names the offending variable in the error', () => {
    expect(() => parseRetentionDays(auditRule, 'nope')).toThrow(/AUDIT_LOG_RETENTION_DAYS/);
  });
});

describe('resolveRetentionPolicy', () => {
  const now = new Date('2026-08-16T00:00:00.000Z');

  it('computes a cutoff per rule from a single reference time', () => {
    const policy = resolveRetentionPolicy({}, now);

    for (const rule of policy) {
      const expected = now.getTime() - rule.days * 86_400_000;
      expect(rule.cutoff.getTime()).toBe(expected);
    }
  });

  it('applies environment overrides', () => {
    const policy = resolveRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: '7' }, now);
    const audit = policy.find((r) => r.target === 'auditLog')!;

    expect(audit.days).toBe(7);
    expect(audit.cutoff.toISOString()).toBe('2026-08-09T00:00:00.000Z');
  });

  it('leaves other rules on their defaults when one is overridden', () => {
    const policy = resolveRetentionPolicy({ AUDIT_LOG_RETENTION_DAYS: '7' }, now);
    const webhook = policy.find((r) => r.target === 'webhookEvent')!;
    expect(webhook.days).toBe(30);
  });

  it('propagates a configuration error rather than starting a partial run', () => {
    expect(() => resolveRetentionPolicy({ SCAN_RESULT_RETENTION_DAYS: 'soon' }, now)).toThrow(
      RetentionConfigError
    );
  });

  it('returns one entry per rule', () => {
    expect(resolveRetentionPolicy({}, now)).toHaveLength(RETENTION_RULES.length);
  });

  it('puts every cutoff in the past', () => {
    for (const rule of resolveRetentionPolicy({}, now)) {
      expect(rule.cutoff.getTime()).toBeLessThan(now.getTime());
    }
  });
});

describe('retentionFor', () => {
  it('looks a rule up by target', () => {
    expect(retentionFor('auditLog', {}, new Date()).envVar).toBe('AUDIT_LOG_RETENTION_DAYS');
  });

  it('throws for an unknown target', () => {
    // @ts-expect-error deliberately invalid target
    expect(() => retentionFor('nope', {}, new Date())).toThrow(RetentionConfigError);
  });
});
