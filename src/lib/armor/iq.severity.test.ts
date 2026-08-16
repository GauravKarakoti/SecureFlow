import { describe, it, expect, vi } from 'vitest';
import type { ScanFinding } from './scanner';

// The policy engine imports prisma for the unrelated `getRiskTrend` aggregate.
// `evaluateFindings` is pure, so the client is stubbed rather than connected.
vi.mock('@/lib/prisma', () => ({
  default: { scanResult: { aggregate: vi.fn() } },
}));

const { ArmorIQPolicyEngine } = await import('./iq');

/** Build a finding carrying an arbitrary severity, bypassing the compile-time type. */
function finding(severity: unknown): ScanFinding {
  return {
    type: 'Hardcoded Secret',
    severity: severity as ScanFinding['severity'],
    description: 'test finding',
    fileLocation: 'src/index.ts',
    codeSnippet: 'const key = "..."',
  };
}

describe('ArmorIQPolicyEngine.evaluateFindings', () => {
  const engine = new ArmorIQPolicyEngine();

  it('passes an empty finding set', () => {
    expect(engine.evaluateFindings([])).toBe('PASS');
  });

  it('blocks on a canonical CRITICAL', () => {
    expect(engine.evaluateFindings([finding('CRITICAL')])).toBe('BLOCKED');
  });

  it('blocks on a lowercase critical — regression for the exact-match bug', () => {
    // Before normalization this returned PASS: `"critical" === 'CRITICAL'` is
    // false, so the finding fell through both branches and the pull request was
    // merged with a critical vulnerability in it.
    expect(engine.evaluateFindings([finding('critical')])).toBe('BLOCKED');
    expect(engine.evaluateFindings([finding('Critical')])).toBe('BLOCKED');
    expect(engine.evaluateFindings([finding('  CRITICAL  ')])).toBe('BLOCKED');
  });

  it('blocks on an aliased critical', () => {
    expect(engine.evaluateFindings([finding('sev1')])).toBe('BLOCKED');
    expect(engine.evaluateFindings([finding('blocker')])).toBe('BLOCKED');
  });

  it('requires review for HIGH and MEDIUM in any casing', () => {
    expect(engine.evaluateFindings([finding('HIGH')])).toBe('REVIEW REQUIRED');
    expect(engine.evaluateFindings([finding('high')])).toBe('REVIEW REQUIRED');
    expect(engine.evaluateFindings([finding('MEDIUM')])).toBe('REVIEW REQUIRED');
    expect(engine.evaluateFindings([finding('moderate')])).toBe('REVIEW REQUIRED');
  });

  it('passes LOW and NONE', () => {
    expect(engine.evaluateFindings([finding('LOW')])).toBe('PASS');
    expect(engine.evaluateFindings([finding('low')])).toBe('PASS');
    expect(engine.evaluateFindings([finding('NONE')])).toBe('PASS');
  });

  it('routes an uninterpretable severity to review instead of silently passing', () => {
    expect(engine.evaluateFindings([finding('who knows')])).toBe('REVIEW REQUIRED');
    expect(engine.evaluateFindings([finding(null)])).toBe('REVIEW REQUIRED');
    expect(engine.evaluateFindings([finding(undefined)])).toBe('REVIEW REQUIRED');
  });

  it('does not throw on a null severity', () => {
    expect(() => engine.evaluateFindings([finding(null)])).not.toThrow();
  });

  it('lets the most severe finding decide the outcome', () => {
    const mixed = [finding('LOW'), finding('none'), finding('critical'), finding('MEDIUM')];
    expect(engine.evaluateFindings(mixed)).toBe('BLOCKED');
  });

  it('does not block when the worst finding is only HIGH', () => {
    expect(engine.evaluateFindings([finding('LOW'), finding('high')])).toBe('REVIEW REQUIRED');
  });
});
