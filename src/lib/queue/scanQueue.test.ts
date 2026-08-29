import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that survive vi.mock hoisting
const { mockQueueInstance, MockQueue, mockPrisma } = vi.hoisted(() => {
  const mockQueueInstance = {
    add: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
    getJob: vi.fn(),
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getActiveCount: vi.fn().mockResolvedValue(1),
    getCompletedCount: vi.fn().mockResolvedValue(10),
    getFailedCount: vi.fn().mockResolvedValue(1),
    getDelayedCount: vi.fn().mockResolvedValue(0),
  };

  class MockQueue {
  constructor() {
    Object.assign(this, mockQueueInstance);
  }
}

  const mockPrisma = {
    scanJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  return { mockQueueInstance, MockQueue, mockPrisma };
});

vi.mock('bullmq', () => ({
  Queue: MockQueue,
}));

vi.mock('./redis', () => ({
  redis: { host: 'localhost', port: 6379 },
}));

vi.mock('@/lib/prisma', () => ({
  default: mockPrisma,
}));

// Import after mocks are set up
import { enqueueScan, getScanJobStatus, updateScanJobProgress, getScanQueueMetrics } from './scanQueue';

describe('scanQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enqueueScan', () => {
    it('creates a ScanJob record and enqueues the job', async () => {
      const mockScanJob = { id: 'scan-123', status: 'PENDING', totalFiles: 5 };
      mockPrisma.scanJob.create.mockResolvedValue(mockScanJob);

      const result = await enqueueScan({
        scanJobId: '',
        repositoryId: 'repo-1',
        installationId: 12345,
        repositoryFullName: 'owner/repo',
        prNumber: 42,
        headSha: 'abc123',
        fileChanges: [{ filename: 'test.ts', patch: '+code' }],
        activePolicies: [],
        customIgnores: [],
        customPlaceholders: [],
      });

      expect(result.scanJobId).toBe('scan-123');
      expect(result.jobId).toContain('scan-');
      expect(mockPrisma.scanJob.create).toHaveBeenCalledWith({
        data: {
          repositoryId: 'repo-1',
          status: 'PENDING',
          totalFiles: 1,
          scannedFiles: 0,
          vulnerabilitiesFound: 0,
        },
      });
    });
  });

  describe('getScanJobStatus', () => {
    it('returns null for non-existent job', async () => {
      mockPrisma.scanJob.findUnique.mockResolvedValue(null);

      const result = await getScanJobStatus('non-existent');
      expect(result).toBeNull();
    });

    it('returns status with progress percentage', async () => {
      const mockJob = {
        id: 'scan-123',
        status: 'PROCESSING',
        totalFiles: 10,
        scannedFiles: 5,
        vulnerabilitiesFound: 2,
        riskScore: null,
        policyDecision: null,
        error: null,
        queuedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
      };
      mockPrisma.scanJob.findUnique.mockResolvedValue(mockJob);

      const result = await getScanJobStatus('scan-123');
      expect(result).not.toBeNull();
      expect(result!.progress).toBe(50);
      expect(result!.status).toBe('PROCESSING');
    });

    it('calculates 100% progress when all files scanned', async () => {
      const mockJob = {
        id: 'scan-123',
        status: 'COMPLETED',
        totalFiles: 5,
        scannedFiles: 5,
        vulnerabilitiesFound: 3,
        riskScore: 75,
        policyDecision: 'BLOCK',
        error: null,
        queuedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      };
      mockPrisma.scanJob.findUnique.mockResolvedValue(mockJob);

      const result = await getScanJobStatus('scan-123');
      expect(result!.progress).toBe(100);
      expect(result!.status).toBe('COMPLETED');
      expect(result!.riskScore).toBe(75);
    });
  });

  describe('updateScanJobProgress', () => {
    it('updates the scan job in the database', async () => {
      mockPrisma.scanJob.update.mockResolvedValue({});

      await updateScanJobProgress('scan-123', {
        scannedFiles: 5,
        vulnerabilitiesFound: 1,
      });

      expect(mockPrisma.scanJob.update).toHaveBeenCalledWith({
        where: { id: 'scan-123' },
        data: {
          scannedFiles: 5,
          vulnerabilitiesFound: 1,
        },
      });
    });
  });

  describe('getScanQueueMetrics', () => {
    it('returns queue metrics', async () => {
      const metrics = await getScanQueueMetrics();
      expect(metrics).toEqual({
        waiting: 0,
        active: 1,
        completed: 10,
        failed: 1,
        delayed: 0,
      });
    });
  });
});
