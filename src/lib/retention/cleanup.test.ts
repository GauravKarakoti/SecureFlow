import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanupDataRetention,
  parseDataRetentionDays,
  resolveDataRetentionDays,
  calculateRetentionCutoff,
  DEFAULT_CLEANUP_BATCH_SIZE,
} from "./cleanup";
import { RetentionConfigError } from "./policy";

const NOW = new Date("2026-08-16T12:00:00.000Z");

interface MockRow {
  id: string;
  createdAt?: Date;
  timestamp?: Date;
  [key: string]: any;
}

/**
 * In-memory test mock for Prisma client.
 * Accurately tracks findings and audit logs, supporting filtering and deletion.
 */
function createMockPrisma(
  initialData: {
    findings?: MockRow[];
    auditLogs?: MockRow[];
    users?: MockRow[];
    repositories?: MockRow[];
    policies?: MockRow[];
  } = {},
) {
  const store = {
    findings: [...(initialData.findings ?? [])],
    auditLogs: [...(initialData.auditLogs ?? [])],
    users: [...(initialData.users ?? [{ id: "user-1", name: "Operator" }])],
    repositories: [...(initialData.repositories ?? [{ id: "repo-1", name: "Main Repo" }])],
    policies: [...(initialData.policies ?? [{ id: "policy-1", name: "Strict Auth" }])],
  };

  const db = {
    finding: {
      count: vi.fn(async (args?: any) => {
        const lt: Date = args?.where?.createdAt?.lt;
        return store.findings.filter((f) => !lt || f.createdAt! < lt).length;
      }),
      findMany: vi.fn(async (args?: any) => {
        const lt: Date = args?.where?.createdAt?.lt;
        const take: number = args?.take ?? 500;
        const matched = store.findings.filter((f) => !lt || f.createdAt! < lt);
        return matched.slice(0, take).map((f) => ({ id: f.id }));
      }),
      deleteMany: vi.fn(async (args?: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        const initialCount = store.findings.length;
        store.findings = store.findings.filter((f) => !ids.includes(f.id));
        return { count: initialCount - store.findings.length };
      }),
    },
    auditLog: {
      count: vi.fn(async (args?: any) => {
        const lt: Date = args?.where?.timestamp?.lt;
        return store.auditLogs.filter((l) => !lt || l.timestamp! < lt).length;
      }),
      findMany: vi.fn(async (args?: any) => {
        const lt: Date = args?.where?.timestamp?.lt;
        const take: number = args?.take ?? 500;
        const matched = store.auditLogs.filter((l) => !lt || l.timestamp! < lt);
        return matched.slice(0, take).map((l) => ({ id: l.id }));
      }),
      deleteMany: vi.fn(async (args?: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        const initialCount = store.auditLogs.length;
        store.auditLogs = store.auditLogs.filter((l) => !ids.includes(l.id));
        return { count: initialCount - store.auditLogs.length };
      }),
      create: vi.fn(async (args?: any) => {
        const entry = { id: `audit-new-${Date.now()}`, ...args.data, timestamp: NOW };
        store.auditLogs.push(entry);
        return entry;
      }),
    },
    // Expose stores for asserting user/repo/policy immutability
    users: store.users,
    repositories: store.repositories,
    policies: store.policies,
    store,
  };

  return db;
}

describe("Data Retention Cleanup - Engine (cleanupDataRetention)", () => {
  describe("Configuration & Cutoff Calculation", () => {
    it("returns null when DATA_RETENTION_DAYS is unset or empty (disabled by default)", () => {
      expect(parseDataRetentionDays(undefined)).toBeNull();
      expect(parseDataRetentionDays("")).toBeNull();
      expect(parseDataRetentionDays("   ")).toBeNull();
      expect(resolveDataRetentionDays({})).toBeNull();
    });

    it("parses valid DATA_RETENTION_DAYS values", () => {
      expect(parseDataRetentionDays("30")).toBe(30);
      expect(parseDataRetentionDays(" 90 ")).toBe(90);
      expect(parseDataRetentionDays("365")).toBe(365);
    });

    it("rejects non-integer, negative, zero, or out-of-range retention values", () => {
      expect(() => parseDataRetentionDays("invalid")).toThrow(RetentionConfigError);
      expect(() => parseDataRetentionDays("14.5")).toThrow(RetentionConfigError);
      expect(() => parseDataRetentionDays("0")).toThrow(RetentionConfigError);
      expect(() => parseDataRetentionDays("-5")).toThrow(RetentionConfigError);
      expect(() => parseDataRetentionDays("5000")).toThrow(RetentionConfigError);
    });

    it("calculates retention cutoff accurately", () => {
      const cutoff = calculateRetentionCutoff(30, NOW);
      const expectedTime = NOW.getTime() - 30 * 24 * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBe(expectedTime);
    });
  });

  describe("Off by Default Behavior", () => {
    it("does not delete anything and returns enabled: false when DATA_RETENTION_DAYS is not set", async () => {
      const db = createMockPrisma({
        findings: [{ id: "old-f1", createdAt: new Date("2025-01-01T00:00:00.000Z") }],
        auditLogs: [{ id: "old-a1", timestamp: new Date("2025-01-01T00:00:00.000Z") }],
      });

      const result = await cleanupDataRetention(db, { env: {}, now: NOW });

      expect(result.enabled).toBe(false);
      expect(result.findingsDeleted).toBe(0);
      expect(result.auditLogsDeleted).toBe(0);
      expect(db.finding.deleteMany).not.toHaveBeenCalled();
      expect(db.auditLog.deleteMany).not.toHaveBeenCalled();
      expect(db.store.findings).toHaveLength(1);
      expect(db.store.auditLogs).toHaveLength(1);
    });
  });

  describe("Dry-Run Mode", () => {
    it("reports counts of older rows without deleting anything", async () => {
      // 30 days retention: cutoff is 2026-07-17T12:00:00.000Z
      const db = createMockPrisma({
        findings: [
          { id: "old-f1", createdAt: new Date("2026-05-01T00:00:00.000Z") }, // Old
          { id: "old-f2", createdAt: new Date("2026-06-01T00:00:00.000Z") }, // Old
          { id: "new-f1", createdAt: new Date("2026-08-10T00:00:00.000Z") }, // New
        ],
        auditLogs: [
          { id: "old-a1", timestamp: new Date("2026-01-01T00:00:00.000Z") }, // Old
          { id: "new-a1", timestamp: new Date("2026-08-15T00:00:00.000Z") }, // New
        ],
      });

      const result = await cleanupDataRetention(db, {
        days: 30,
        dryRun: true,
        now: NOW,
      });

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.findingsDeleted).toBe(0);
      expect(result.auditLogsDeleted).toBe(0);
      expect(result.findingsEligible).toBe(2);
      expect(result.auditLogsEligible).toBe(1);
      expect(result.totalAffected).toBe(3);

      // Verify NO deletion queries were performed
      expect(db.finding.deleteMany).not.toHaveBeenCalled();
      expect(db.auditLog.deleteMany).not.toHaveBeenCalled();

      // Verify all rows are still present in database
      expect(db.store.findings).toHaveLength(3);
      expect(db.store.auditLogs).toHaveLength(2);
    });
  });

  describe("Applied Cleanup Mode (Old vs. New Retention)", () => {
    it("deletes only old findings and audit logs, preserving newer rows", async () => {
      // 30 days retention: cutoff is 2026-07-17T12:00:00.000Z
      const oldFinding1 = { id: "old-f1", createdAt: new Date("2026-05-01T00:00:00.000Z") };
      const oldFinding2 = { id: "old-f2", createdAt: new Date("2026-07-01T00:00:00.000Z") };
      const newFinding1 = { id: "new-f1", createdAt: new Date("2026-08-01T00:00:00.000Z") };
      const newFinding2 = { id: "new-f2", createdAt: new Date("2026-08-16T11:00:00.000Z") };

      const oldAuditLog = { id: "old-a1", timestamp: new Date("2026-06-01T00:00:00.000Z") };
      const newAuditLog = { id: "new-a1", timestamp: new Date("2026-08-10T00:00:00.000Z") };

      const db = createMockPrisma({
        findings: [oldFinding1, oldFinding2, newFinding1, newFinding2],
        auditLogs: [oldAuditLog, newAuditLog],
      });

      const result = await cleanupDataRetention(db, {
        days: 30,
        dryRun: false,
        now: NOW,
      });

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(result.findingsDeleted).toBe(2);
      expect(result.auditLogsDeleted).toBe(1);
      expect(result.totalAffected).toBe(3);

      // Verify remaining findings are ONLY the new ones
      const remainingFindingIds = db.store.findings.map((f) => f.id);
      expect(remainingFindingIds).toEqual(["new-f1", "new-f2"]);
      expect(remainingFindingIds).not.toContain("old-f1");
      expect(remainingFindingIds).not.toContain("old-f2");

      // Verify remaining audit logs include the new one (plus the log written for the cleanup itself)
      const remainingAuditIds = db.store.auditLogs.map((a) => a.id);
      expect(remainingAuditIds).toContain("new-a1");
      expect(remainingAuditIds).not.toContain("old-a1");
    });

    it("operates in batches when processing large sets of records", async () => {
      // Seed 12 old findings with batchSize = 5
      const oldFindings: MockRow[] = Array.from({ length: 12 }, (_, i) => ({
        id: `f-${i}`,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }));

      const db = createMockPrisma({ findings: oldFindings });

      const result = await cleanupDataRetention(db, {
        days: 30,
        dryRun: false,
        batchSize: 5,
        now: NOW,
      });

      expect(result.findingsDeleted).toBe(12);
      expect(db.store.findings).toHaveLength(0);
      // 12 items in batches of 5 = 3 batch roundtrips (5 + 5 + 2)
      expect(db.finding.findMany).toHaveBeenCalledTimes(3);
      expect(db.finding.deleteMany).toHaveBeenCalledTimes(3);
    });

    it("NEVER deletes users, repositories, or policies", async () => {
      const initialUsers = [
        { id: "u-1", name: "Admin" },
        { id: "u-2", name: "Dev" },
      ];
      const initialRepos = [{ id: "r-1", name: "Repo A" }];
      const initialPolicies = [{ id: "p-1", name: "Policy X" }];

      const db = createMockPrisma({
        users: initialUsers,
        repositories: initialRepos,
        policies: initialPolicies,
        findings: [{ id: "old-f", createdAt: new Date("2025-01-01") }],
        auditLogs: [{ id: "old-a", timestamp: new Date("2025-01-01") }],
      });

      await cleanupDataRetention(db, {
        days: 30,
        dryRun: false,
        now: NOW,
      });

      // Assert that user, repository, and policy collections are 100% untouched
      expect(db.users).toEqual(initialUsers);
      expect(db.repositories).toEqual(initialRepos);
      expect(db.policies).toEqual(initialPolicies);
    });
  });
});
