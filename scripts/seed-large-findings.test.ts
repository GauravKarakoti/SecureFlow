import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  repository: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  pullRequest: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  scanResult: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  finding: {
    createMany: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma", () => ({
  default: mockPrisma,
}));

import { seedLargeFindings } from "./seed-large-findings";

describe("seedLargeFindings script", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma.user.findFirst.mockResolvedValue({ id: "user-1", email: "perf@test.com" });
    mockPrisma.repository.findFirst.mockResolvedValue({ id: "repo-1" });
    mockPrisma.pullRequest.findFirst.mockResolvedValue({ id: "pr-1" });
    mockPrisma.scanResult.findFirst.mockResolvedValue({ id: "scan-1" });
    mockPrisma.finding.createMany.mockResolvedValue({ count: 1000 });
  });

  it("seeds 5,000 findings across multiple batches", async () => {
    await seedLargeFindings(5000);

    // 5000 / 1000 = 5 batches
    expect(mockPrisma.finding.createMany).toHaveBeenCalledTimes(5);

    const firstBatchCall = mockPrisma.finding.createMany.mock.calls[0]![0];
    expect(firstBatchCall.data).toHaveLength(1000);
    expect(firstBatchCall.skipDuplicates).toBe(true);

    const sample = firstBatchCall.data[0];
    expect(sample.scanResultId).toBe("scan-1");
    expect(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).toContain(sample.severity);
    expect(["SECRET", "VULNERABILITY", "MISCONFIG"]).toContain(sample.type);
    expect(sample.fingerprint).toBeDefined();
  });

  it("creates user, repo, pr, and scan if they do not exist", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: "user-new" });

    mockPrisma.repository.findFirst.mockResolvedValue(null);
    mockPrisma.repository.create.mockResolvedValue({ id: "repo-new" });

    mockPrisma.pullRequest.findFirst.mockResolvedValue(null);
    mockPrisma.pullRequest.create.mockResolvedValue({ id: "pr-new" });

    mockPrisma.scanResult.findFirst.mockResolvedValue(null);
    mockPrisma.scanResult.create.mockResolvedValue({ id: "scan-new" });

    await seedLargeFindings(100);

    expect(mockPrisma.user.create).toHaveBeenCalled();
    expect(mockPrisma.repository.create).toHaveBeenCalled();
    expect(mockPrisma.pullRequest.create).toHaveBeenCalled();
    expect(mockPrisma.scanResult.create).toHaveBeenCalled();
    expect(mockPrisma.finding.createMany).toHaveBeenCalledTimes(1);
  });
});
