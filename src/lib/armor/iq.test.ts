import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArmorIQPolicyEngine } from './iq';
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
