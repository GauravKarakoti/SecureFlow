import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, countMock, scanJobFindFirstMock, findingFindFirstMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn(),
  scanJobFindFirstMock: vi.fn(),
  findingFindFirstMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    armorIQEnforcementLog: {
      findMany: findManyMock,
      count: countMock,
    },
    scanJob: {
      findFirst: scanJobFindFirstMock,
    },
    finding: {
      findFirst: findingFindFirstMock,
    },
  },
}));

import {
  fetchArmorIQAuditTraces,
  verifyArmorIQAuditResourceOwnership,
  buildComplianceReport,
} from "./audit-integration";

describe("ArmorIQ audit tenancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);
    scanJobFindFirstMock.mockResolvedValue({ id: "job-1" });
    findingFindFirstMock.mockResolvedValue({ id: "finding-1" });
  });

  it("scopes trace reads through both owning relations", async () => {
    await fetchArmorIQAuditTraces({
      userId: "user-1",
      scanJobId: "job-1",
      decision: "BLOCK",
    });

    const query = findManyMock.mock.calls[0][0];
    expect(query.where).toMatchObject({
      scanJobId: "job-1",
      decision: "BLOCK",
      OR: [
        { scanJob: { is: { repository: { is: { userId: "user-1" } } } } },
        {
          finding: {
            is: {
              scanResult: {
                is: {
                  pullRequest: { is: { repository: { is: { userId: "user-1" } } } },
                },
              },
            },
          },
        },
      ],
    });
    expect(countMock).toHaveBeenCalledWith({ where: query.where });
  });

  it("does not accept a scan job owned by another user", async () => {
    scanJobFindFirstMock.mockResolvedValueOnce(null);

    await expect(
      verifyArmorIQAuditResourceOwnership({ userId: "user-1", scanJobId: "job-2" }),
    ).resolves.toBe(false);

    expect(scanJobFindFirstMock).toHaveBeenCalledWith({
      where: { id: "job-2", repository: { is: { userId: "user-1" } } },
      select: { id: true },
    });
  });

  it("does not accept a finding owned by another user", async () => {
    findingFindFirstMock.mockResolvedValueOnce(null);

    await expect(
      verifyArmorIQAuditResourceOwnership({ userId: "user-1", findingId: "finding-2" }),
    ).resolves.toBe(false);

    expect(findingFindFirstMock).toHaveBeenCalledWith({
      where: {
        id: "finding-2",
        scanResult: {
          is: {
            pullRequest: { is: { repository: { is: { userId: "user-1" } } } },
          },
        },
      },
      select: { id: true },
    });
  });

  it("requires every supplied resource to belong to the user", async () => {
    scanJobFindFirstMock.mockResolvedValueOnce({ id: "job-1" });
    findingFindFirstMock.mockResolvedValueOnce({ id: "finding-1" });

    await expect(
      verifyArmorIQAuditResourceOwnership({
        userId: "user-1",
        scanJobId: "job-1",
        findingId: "finding-1",
      }),
    ).resolves.toBe(true);

    findingFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      verifyArmorIQAuditResourceOwnership({
        userId: "user-1",
        scanJobId: "job-1",
        findingId: "finding-2",
      }),
    ).resolves.toBe(false);
  });

  it("allows an unlinked record without a database lookup", async () => {
    await expect(verifyArmorIQAuditResourceOwnership({ userId: "user-1" })).resolves.toBe(true);

    expect(scanJobFindFirstMock).not.toHaveBeenCalled();
    expect(findingFindFirstMock).not.toHaveBeenCalled();
  });

  it("handles cursor-based pagination and nextCursor resolution", async () => {
    const mockTrace = (id: string, dateStr: string) => ({
      id,
      agentId: "agent-1",
      toolName: "eval",
      decision: "ALLOW",
      ruleMatched: null,
      justification: null,
      proofHash: null,
      signature: null,
      intentId: null,
      frameworks: ["SOC2"],
      privacyLevel: "INTERNAL",
      timestamp: new Date(dateStr),
      createdAt: new Date(dateStr),
    });

    // 3 traces returned when limit is 2 -> slices to 2 and sets nextCursor
    findManyMock.mockResolvedValueOnce([
      mockTrace("t-1", "2026-01-03T00:00:00Z"),
      mockTrace("t-2", "2026-01-02T00:00:00Z"),
      mockTrace("t-3", "2026-01-01T00:00:00Z"),
    ]);
    countMock.mockResolvedValueOnce(5);

    const result = await fetchArmorIQAuditTraces({
      userId: "user-1",
      cursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTAxLTAzVDAwOjAwOjAwLjAwMFoiLCJpZCI6InQtMCJ9",
      limit: 2,
    });

    expect(result.traces).toHaveLength(2);
    expect(result.nextCursor).toBeDefined();

    // Offset based nextCursor
    findManyMock.mockResolvedValueOnce([mockTrace("t-1", "2026-01-03T00:00:00Z")]);
    countMock.mockResolvedValueOnce(10);
    const offsetResult = await fetchArmorIQAuditTraces({
      userId: "user-1",
      offset: 0,
      limit: 1,
    });
    expect(offsetResult.nextCursor).toBeDefined();
  });

  it("builds compliance report for frameworks", () => {
    const report = buildComplianceReport([
      {
        id: "trace-1",
        agentId: "agent-alpha",
        toolName: "remediation_patch",
        decision: "ALLOW",
        ruleMatched: "SEC-POL-001",
        justification: "Valid patch",
        proofHash: "hash-123",
        signature: "sig-123",
        frameworks: ["SOC2", "ISO27001"],
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "trace-2",
        agentId: "agent-beta",
        toolName: "shell_exec",
        decision: "BLOCK",
        ruleMatched: null,
        justification: null,
        proofHash: null,
        signature: null,
        frameworks: [],
        timestamp: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    expect(report).toHaveLength(2);
    expect(report[0].ruleEnforced).toBe("SEC-POL-001");
    expect(report[1].ruleEnforced).toBe("Default Zero-Trust Boundary");
  });
});
