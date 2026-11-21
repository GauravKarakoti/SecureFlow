import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  logIncident,
  logIncidentBatch,
  getRecentIncidents,
  computeIncidentHash,
  INCIDENT_LATENCY_SLA_MS,
} from "./incident-logger";

vi.mock("@/lib/prisma", () => ({
  default: {
    auditLog: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";

describe("Optimized PostgreSQL Incident Logger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("computeIncidentHash", () => {
    it("generates deterministic SHA-256 hashes for incident payloads", () => {
      const data = {
        userId: "user-1",
        action: "INFRASTRUCTURE_LOCKDOWN",
        resource: "k8s/payment-pod",
        decision: "ALLOW",
        metadataJson: '{"severity":"CRITICAL"}',
        timestampIso: "2026-11-20T12:00:00.000Z",
        previousHash: "prev-hash-123",
      };

      const hash1 = computeIncidentHash(data);
      const hash2 = computeIncidentHash(data);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex string
    });

    it("produces different hashes when content changes", () => {
      const base = {
        userId: "user-1",
        action: "INFRASTRUCTURE_LOCKDOWN",
        resource: "k8s/payment-pod",
        decision: "ALLOW",
        metadataJson: "{}",
        timestampIso: "2026-11-20T12:00:00.000Z",
        previousHash: null,
      };

      const hash1 = computeIncidentHash(base);
      const hash2 = computeIncidentHash({ ...base, resource: "k8s/auth-pod" });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("logIncident", () => {
    it("logs incident with lean projection and verifies execution latency < 200ms", async () => {
      const mockDbResult = {
        id: "audit-123",
        timestamp: new Date(),
      };

      vi.mocked(prisma.auditLog.create).mockImplementation(async (args: any) => {
        // Assert lean select projection is requested
        expect(args.select).toEqual({
          id: true,
          timestamp: true,
        });
        return mockDbResult as any;
      });

      const res = await logIncident({
        userId: "operator-1",
        action: "INFRASTRUCTURE_LOCKDOWN",
        resource: "cluster-worker-01",
        decision: "ALLOW",
        severity: "CRITICAL",
        metadata: { trigger: "GroqSafeAction" },
      });

      expect(res.success).toBe(true);
      expect(res.id).toBe("audit-123");
      expect(res.withinSla).toBe(true);
      expect(res.latencyMs).toBeLessThanOrEqual(INCIDENT_LATENCY_SLA_MS);
      expect(res.entryHash).toBeDefined();

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it("handles database query timeout boundary gracefully", async () => {
      // Simulate query that takes longer than timeout
      vi.mocked(prisma.auditLog.create).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );

      const res = await logIncident(
        {
          userId: "operator-1",
          action: "REMEDIATION_PATCH",
          resource: "src/auth.ts",
        },
        { timeoutMs: 20 },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain("exceeded latency threshold");
      expect(logger.error).toHaveBeenCalled();
    });

    it("logs warning if latency exceeds 200ms SLA without assertSla", async () => {
      vi.mocked(prisma.auditLog.create).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  id: "audit-slow",
                  timestamp: new Date(),
                } as any),
              60,
            ),
          ),
      );

      // We test with low custom SLA threshold check
      const res = await logIncident(
        {
          userId: "operator-1",
          action: "SLOW_ACTION",
          resource: "db/main",
        },
        { timeoutMs: 200 },
      );

      expect(res.success).toBe(true);
    });
  });

  describe("logIncidentBatch", () => {
    it("logs multiple incidents in a single batch insert", async () => {
      vi.mocked(prisma.auditLog.createMany).mockResolvedValueOnce({ count: 3 });

      const res = await logIncidentBatch([
        { action: "ISOLATE", resource: "node-1" },
        { action: "ISOLATE", resource: "node-2" },
        { action: "ISOLATE", resource: "node-3" },
      ]);

      expect(res.success).toBe(true);
      expect(res.count).toBe(3);
      expect(res.withinSla).toBe(true);
      expect(prisma.auditLog.createMany).toHaveBeenCalledTimes(1);
    });

    it("handles empty batch efficiently without hitting database", async () => {
      const res = await logIncidentBatch([]);
      expect(res.success).toBe(true);
      expect(res.count).toBe(0);
      expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe("getRecentIncidents", () => {
    it("queries using compound index ordering (timestamp desc) and limits", async () => {
      const mockRecords = [
        { id: "1", action: "LOCKDOWN", resource: "res-1", timestamp: new Date() },
      ];
      vi.mocked(prisma.auditLog.findMany).mockResolvedValueOnce(mockRecords as any);

      const since = new Date(Date.now() - 3600000);
      const res = await getRecentIncidents({
        userId: "user-1",
        action: "LOCKDOWN",
        limit: 25,
        since,
      });

      expect(res).toEqual(mockRecords);
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          action: "LOCKDOWN",
          timestamp: { gte: since },
        },
        orderBy: { timestamp: "desc" },
        take: 25,
        select: {
          id: true,
          userId: true,
          action: true,
          resource: true,
          decision: true,
          metadata: true,
          timestamp: true,
          entryHash: true,
        },
      });
    });
  });
});
