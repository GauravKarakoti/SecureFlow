import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArmorIQPolicyEngine, ArmorIQService, PolicyResult } from './iq';
import prisma from '@/lib/prisma';

vi.mock('@/lib/prisma', () => {
  return {
    default: {
      scanResult: {
        aggregate: vi.fn(),
      },
    },
  };
});

describe('ArmorIQPolicyEngine getRiskTrend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calculates average risk score without filters', async () => {
    const engine = new ArmorIQPolicyEngine();
    const aggregateMock = vi.mocked(prisma.scanResult.aggregate) as any;
    aggregateMock.mockResolvedValue({
      _avg: {
        riskScore: 42,
      },
    });

    const result = await engine.getRiskTrend();
    expect(result).toBe(42);
    expect(aggregateMock).toHaveBeenCalledWith({
      where: {},
      _avg: {
        riskScore: true,
      },
    });
  });

  it('calculates average risk score with repositoryId filter', async () => {
    const engine = new ArmorIQPolicyEngine();
    const aggregateMock = vi.mocked(prisma.scanResult.aggregate) as any;
    aggregateMock.mockResolvedValue({
      _avg: {
        riskScore: 25,
      },
    });

    const result = await engine.getRiskTrend({ repositoryId: 'repo-123' });
    expect(result).toBe(25);
    expect(aggregateMock).toHaveBeenCalledWith({
      where: {
        pullRequest: {
          repositoryId: 'repo-123',
        },
      },
      _avg: {
        riskScore: true,
      },
    });
  });

  it('calculates average risk score with userId filter', async () => {
    const engine = new ArmorIQPolicyEngine();
    const aggregateMock = vi.mocked(prisma.scanResult.aggregate) as any;
    aggregateMock.mockResolvedValue({
      _avg: {
        riskScore: 50,
      },
    });

    const result = await engine.getRiskTrend({ userId: 'user-456' });
    expect(result).toBe(50);
    expect(aggregateMock).toHaveBeenCalledWith({
      where: {
        pullRequest: {
          repository: {
            userId: 'user-456',
          },
        },
      },
      _avg: {
        riskScore: true,
      },
    });
  });

  it('returns 0 if aggregation returns null/undefined riskScore', async () => {
    const engine = new ArmorIQPolicyEngine();
    const aggregateMock = vi.mocked(prisma.scanResult.aggregate) as any;
    aggregateMock.mockResolvedValue({
      _avg: {
        riskScore: null,
      },
    });

    const result = await engine.getRiskTrend();
    expect(result).toBe(0);
  });

  it('returns 0 and logs error on database failure', async () => {
    const engine = new ArmorIQPolicyEngine();
    const aggregateMock = vi.mocked(prisma.scanResult.aggregate) as any;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    aggregateMock.mockRejectedValue(new Error('DB Connection Timeout'));

    const result = await engine.getRiskTrend();
    expect(result).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---- evaluateFindings ----

describe('ArmorIQPolicyEngine evaluateFindings', () => {
  const engine = new ArmorIQPolicyEngine();

  it('returns PASS for an empty findings array', () => {
    expect(engine.evaluateFindings([])).toBe('PASS');
  });

  it('returns REVIEW REQUIRED for a LOW severity finding', () => {
    const findings = [
      { type: 'INFO', severity: 'LOW', fileLocation: 'src/a.ts', description: 'Trivial' },
    ] as any;
    expect(engine.evaluateFindings(findings)).toBe('PASS');
  });

  it('returns REVIEW REQUIRED for a MEDIUM severity finding', () => {
    const findings = [
      { type: 'VULN', severity: 'MEDIUM', fileLocation: 'src/a.ts', description: 'Medium risk' },
    ] as any;
    expect(engine.evaluateFindings(findings)).toBe('REVIEW REQUIRED');
  });

  it('returns REVIEW REQUIRED for a HIGH severity finding', () => {
    const findings = [
      { type: 'VULN', severity: 'HIGH', fileLocation: 'src/b.ts', description: 'High risk' },
    ] as any;
    expect(engine.evaluateFindings(findings)).toBe('REVIEW REQUIRED');
  });

  it('returns BLOCKED for a CRITICAL severity finding', () => {
    const findings = [
      { type: 'VULN', severity: 'CRITICAL', fileLocation: 'src/c.ts', description: 'Critical' },
    ] as any;
    expect(engine.evaluateFindings(findings)).toBe('BLOCKED');
  });

  it('returns BLOCKED when CRITICAL is mixed with lower severities', () => {
    const findings = [
      { type: 'VULN', severity: 'LOW', fileLocation: 'a.ts', description: 'Low' },
      { type: 'VULN', severity: 'CRITICAL', fileLocation: 'b.ts', description: 'Critical' },
    ] as any;
    expect(engine.evaluateFindings(findings)).toBe('BLOCKED');
  });

  it('returns REVIEW REQUIRED when only HIGH and MEDIUM are present', () => {
    const findings = [
      { type: 'VULN', severity: 'MEDIUM', fileLocation: 'a.ts', description: 'Medium' },
      { type: 'VULN', severity: 'HIGH', fileLocation: 'b.ts', description: 'High' },
    ] as any;
    expect(engine.evaluateFindings(findings)).toBe('REVIEW REQUIRED');
  });
});

// ---- ArmorIQService ----

describe('ArmorIQService', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('isConfigured', () => {
    it('returns false when ARMORIQ_API_KEY is not set', async () => {
      delete process.env.ARMORIQ_API_KEY;
      vi.resetModules();
      const { ArmorIQService: IQ } = await import('./iq');
      expect(IQ.isConfigured()).toBe(false);
    });

    it('returns false when ARMORIQ_API_KEY is empty', async () => {
      process.env.ARMORIQ_API_KEY = '';
      vi.resetModules();
      const { ArmorIQService: IQ } = await import('./iq');
      expect(IQ.isConfigured()).toBe(false);
    });

    it('returns true when ARMORIQ_API_KEY is set', async () => {
      process.env.ARMORIQ_API_KEY = 'some-valid-key';
      vi.resetModules();
      const { ArmorIQService: IQ } = await import('./iq');
      expect(IQ.isConfigured()).toBe(true);
    });
  });

  describe('compileToArmorIQPolicy', () => {
    it('creates allow-all fallback when no active policies exist', () => {
      const policy = ArmorIQService.compileToArmorIQPolicy([]);
      expect(policy.allow).toEqual(['*:*']);
      expect(policy.deny).toEqual([]);
      expect(policy.priority).toBe(50);
    });

    it('creates allow-all fallback when all policies are inactive', () => {
      const policies = [
        { isActive: false, rules: { action: 'BLOCKED', conditions: ['secret/*'] } },
      ];
      const policy = ArmorIQService.compileToArmorIQPolicy(policies);
      expect(policy.allow).toEqual(['*:*']);
    });

    it('maps BLOCKED action to deny array', () => {
      const policies = [
        { isActive: true, rules: { action: 'BLOCKED', conditions: ['secret/*', 'config/*'] } },
      ];
      const policy = ArmorIQService.compileToArmorIQPolicy(policies);
      expect(policy.deny).toEqual(['secret/*', 'config/*']);
      expect(policy.allow).toEqual([]);
    });

    it('maps DENY action to deny array', () => {
      const policies = [
        { isActive: true, rules: { action: 'DENY', conditions: ['admin/*'] } },
      ];
      const policy = ArmorIQService.compileToArmorIQPolicy(policies);
      expect(policy.deny).toEqual(['admin/*']);
    });

    it('maps PASS/ALLOW action to allow array', () => {
      const policies = [
        { isActive: true, rules: { action: 'ALLOW', conditions: ['public/*'] } },
      ];
      const policy = ArmorIQService.compileToArmorIQPolicy(policies);
      expect(policy.allow).toEqual(['public/*']);
    });

    it('combines multiple active policies', () => {
      const policies = [
        { isActive: true, rules: { action: 'ALLOW', conditions: ['public/*'] } },
        { isActive: true, rules: { action: 'BLOCKED', conditions: ['internal/*'] } },
        { isActive: false, rules: { action: 'DENY', conditions: ['ignored/*'] } },
      ];
      const policy = ArmorIQService.compileToArmorIQPolicy(policies);
      expect(policy.allow).toEqual(['public/*']);
      expect(policy.deny).toEqual(['internal/*']);
    });
  });

  describe('getClient', () => {
    it('returns null when not configured', async () => {
      delete process.env.ARMORIQ_API_KEY;
      vi.resetModules();
      const { ArmorIQService: IQ } = await import('./iq');
      expect(IQ.getClient()).toBeNull();
    });
  });
});
