import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateDateCutoff,
  parsePurgeArgs,
  purgeOldData,
  DEFAULT_PURGE_BATCH_SIZE,
} from "./purge-old-data";

describe("purge-old-data script", () => {
  describe("calculateDateCutoff", () => {
    it("correctly subtracts days from reference date", () => {
      const now = new Date("2026-05-15T12:00:00.000Z");
      const cutoff = calculateDateCutoff(30, now);
      expect(cutoff.toISOString()).toBe("2026-04-15T12:00:00.000Z");
    });

    it("handles 0 or 1 day correctly", () => {
      const now = new Date("2026-01-02T00:00:00.000Z");
      const cutoff = calculateDateCutoff(1, now);
      expect(cutoff.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("parsePurgeArgs", () => {
    it("defaults to dryRun: true with empty argv", () => {
      const opts = parsePurgeArgs([]);
      expect(opts.dryRun).toBe(true);
      expect(opts.days).toBeUndefined();
      expect(opts.batchSize).toBeUndefined();
      expect(opts.help).toBe(false);
    });

    it("parses --apply flag to disable dryRun", () => {
      const opts = parsePurgeArgs(["--apply"]);
      expect(opts.dryRun).toBe(false);
    });

    it("parses explicit --dry-run flag", () => {
      const opts = parsePurgeArgs(["--dry-run"]);
      expect(opts.dryRun).toBe(true);
    });

    it("parses --days=<n> correctly", () => {
      const opts = parsePurgeArgs(["--days=90"]);
      expect(opts.days).toBe(90);
    });

    it("throws on invalid --days", () => {
      expect(() => parsePurgeArgs(["--days=-5"])).toThrow(/--days must be a positive integer/);
      expect(() => parsePurgeArgs(["--days=abc"])).toThrow(/--days must be a positive integer/);
      expect(() => parsePurgeArgs(["--days=0"])).toThrow(/--days must be a positive integer/);
    });

    it("parses --batch-size=<n> correctly", () => {
      const opts = parsePurgeArgs(["--batch-size=250"]);
      expect(opts.batchSize).toBe(250);
    });

    it("throws on invalid --batch-size", () => {
      expect(() => parsePurgeArgs(["--batch-size=0"])).toThrow(
        /--batch-size must be a positive integer/,
      );
    });

    it("parses --help / -h", () => {
      expect(parsePurgeArgs(["--help"]).help).toBe(true);
      expect(parsePurgeArgs(["-h"]).help).toBe(true);
    });
  });

  describe("purgeOldData", () => {
    let mockDb: any;

    beforeEach(() => {
      mockDb = {
        finding: {
          count: vi.fn().mockResolvedValue(15),
          findMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        scanResult: {
          count: vi.fn().mockResolvedValue(10),
          findMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        auditLog: {
          count: vi.fn().mockResolvedValue(5),
          findMany: vi.fn(),
          deleteMany: vi.fn(),
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      };
    });

    it("does nothing when DATA_RETENTION_DAYS is unset and no --days passed", async () => {
      const result = await purgeOldData(mockDb, {
        env: {},
      });

      expect(result.enabled).toBe(false);
      expect(result.totalAffected).toBe(0);
      expect(mockDb.finding.count).not.toHaveBeenCalled();
      expect(mockDb.finding.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.scanResult.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.auditLog.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    });

    it("performs dry run by default and counts without deleting", async () => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const result = await purgeOldData(mockDb, {
        days: 60,
        now,
      });

      expect(result.enabled).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.retentionDays).toBe(60);
      expect(result.findingsCount).toBe(15);
      expect(result.scansCount).toBe(10);
      expect(result.auditLogsCount).toBe(5);
      expect(result.totalAffected).toBe(30);

      const expectedCutoff = new Date("2026-04-02T00:00:00.000Z");
      expect(mockDb.finding.count).toHaveBeenCalledWith({
        where: { createdAt: { lt: expectedCutoff } },
      });
      expect(mockDb.scanResult.count).toHaveBeenCalledWith({
        where: { createdAt: { lt: expectedCutoff } },
      });
      expect(mockDb.auditLog.count).toHaveBeenCalledWith({
        where: { timestamp: { lt: expectedCutoff } },
      });

      expect(mockDb.finding.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.scanResult.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.auditLog.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    });

    it("deletes records in batches and records an audit log entry when apply is set", async () => {
      const now = new Date("2026-06-01T00:00:00.000Z");

      // Finding batch 1 (2 items), then batch 2 (empty)
      mockDb.finding.findMany
        .mockResolvedValueOnce([{ id: "f-1" }, { id: "f-2" }])
        .mockResolvedValueOnce([]);
      mockDb.finding.deleteMany.mockResolvedValue({ count: 2 });

      // ScanResult batch 1 (1 item), then empty
      mockDb.scanResult.findMany.mockResolvedValueOnce([{ id: "s-1" }]).mockResolvedValueOnce([]);
      mockDb.scanResult.deleteMany.mockResolvedValue({ count: 1 });

      // AuditLog batch 1 (3 items), then empty
      mockDb.auditLog.findMany
        .mockResolvedValueOnce([{ id: "a-1" }, { id: "a-2" }, { id: "a-3" }])
        .mockResolvedValueOnce([]);
      mockDb.auditLog.deleteMany.mockResolvedValue({ count: 3 });

      const result = await purgeOldData(mockDb, {
        dryRun: false,
        days: 90,
        batchSize: 2,
        now,
      });

      expect(result.enabled).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(result.findingsCount).toBe(2);
      expect(result.scansCount).toBe(1);
      expect(result.auditLogsCount).toBe(3);
      expect(result.totalAffected).toBe(6);

      // Verify deletions
      expect(mockDb.finding.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["f-1", "f-2"] } },
      });
      expect(mockDb.scanResult.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["s-1"] } },
      });
      expect(mockDb.auditLog.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["a-1", "a-2", "a-3"] } },
      });

      // Verify audit log creation
      expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
      const auditPayload = mockDb.auditLog.create.mock.calls[0][0];
      expect(auditPayload.data.action).toBe("DATA_PURGE");
      expect(auditPayload.data.resource).toBe("system");
      expect(auditPayload.data.metadata.findingsDeleted).toBe(2);
      expect(auditPayload.data.metadata.scansDeleted).toBe(1);
      expect(auditPayload.data.metadata.auditLogsDeleted).toBe(3);
      expect(auditPayload.data.metadata.retentionDays).toBe(90);
    });

    it("reads DATA_RETENTION_DAYS from env if options.days not explicitly provided", async () => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const result = await purgeOldData(mockDb, {
        dryRun: true,
        env: { DATA_RETENTION_DAYS: "45" },
        now,
      });

      expect(result.enabled).toBe(true);
      expect(result.retentionDays).toBe(45);
    });
  });
});
