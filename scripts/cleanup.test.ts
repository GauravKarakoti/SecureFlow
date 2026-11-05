import { describe, it, expect, vi } from "vitest";
import { parseCleanupArgs, formatCleanupReport, runCleanupCli } from "./cleanup";
describe("Data Retention Cleanup CLI (scripts/cleanup.ts)", () => {
  describe("parseCleanupArgs", () => {
    it("defaults to dry-run mode when no arguments are provided", () => {
      const options = parseCleanupArgs([]);
      expect(options.dryRun).toBe(true);
      expect(options.help).toBe(false);
      expect(options.days).toBeUndefined();
    });

    it("enables apply mode when --apply is passed", () => {
      const options = parseCleanupArgs(["--apply"]);
      expect(options.dryRun).toBe(false);
    });

    it("explicitly supports --dry-run", () => {
      const options = parseCleanupArgs(["--dry-run"]);
      expect(options.dryRun).toBe(true);
    });

    it("parses valid --days flag", () => {
      const options = parseCleanupArgs(["--days=45"]);
      expect(options.days).toBe(45);
    });

    it("rejects invalid or out-of-range --days values", () => {
      expect(() => parseCleanupArgs(["--days=0"])).toThrow(/between 1 and 3650/);
      expect(() => parseCleanupArgs(["--days=-5"])).toThrow(/between 1 and 3650/);
      expect(() => parseCleanupArgs(["--days=4000"])).toThrow(/between 1 and 3650/);
      expect(() => parseCleanupArgs(["--days=abc"])).toThrow(/whole number/);
    });

    it("parses valid --batch-size flag", () => {
      const options = parseCleanupArgs(["--batch-size=250"]);
      expect(options.batchSize).toBe(250);
    });

    it("rejects invalid --batch-size values", () => {
      expect(() => parseCleanupArgs(["--batch-size=0"])).toThrow(/between 1 and 10000/);
      expect(() => parseCleanupArgs(["--batch-size=20000"])).toThrow(/between 1 and 10000/);
      expect(() => parseCleanupArgs(["--batch-size=xyz"])).toThrow(/whole number/);
    });

    it("recognizes --help and -h flags", () => {
      expect(parseCleanupArgs(["--help"]).help).toBe(true);
      expect(parseCleanupArgs(["-h"]).help).toBe(true);
    });

    it("rejects unrecognized arguments to prevent accidental typos", () => {
      expect(() => parseCleanupArgs(["--aply"])).toThrow(/Unrecognised argument "--aply"/);
    });
  });

  describe("formatCleanupReport", () => {
    it("formats disabled status when retention is off", () => {
      const report = formatCleanupReport({
        success: true,
        enabled: false,
        dryRun: true,
        retentionDays: null,
        cutoff: null,
        findingsDeleted: 0,
        auditLogsDeleted: 0,
        totalAffected: 0,
        message: "Disabled",
      });
      expect(report).toContain("Status: DISABLED");
      expect(report).toContain("DATA_RETENTION_DAYS is not set");
    });

    it("formats dry-run report correctly", () => {
      const report = formatCleanupReport({
        success: true,
        enabled: true,
        dryRun: true,
        retentionDays: 30,
        cutoff: "2026-07-17T12:00:00.000Z",
        findingsDeleted: 0,
        auditLogsDeleted: 0,
        findingsEligible: 12,
        auditLogsEligible: 8,
        totalAffected: 20,
        message: "Dry run complete",
      });
      expect(report).toContain("DRY RUN (nothing deleted)");
      expect(report).toContain("Retention Window : 30 days");
      expect(report).toContain("Findings eligible for deletion  : 12");
      expect(report).toContain("Audit logs eligible for deletion: 8");
      expect(report).toContain("Total rows eligible              : 20");
    });

    it("formats applied deletion report correctly", () => {
      const report = formatCleanupReport({
        success: true,
        enabled: true,
        dryRun: false,
        retentionDays: 30,
        cutoff: "2026-07-17T12:00:00.000Z",
        findingsDeleted: 12,
        auditLogsDeleted: 8,
        totalAffected: 20,
        message: "Applied complete",
      });
      expect(report).toContain("APPLIED");
      expect(report).toContain("Findings deleted  : 12");
      expect(report).toContain("Audit logs deleted: 8");
      expect(report).toContain("Total rows deleted  : 20");
    });
  });

  describe("runCleanupCli", () => {
    it("returns exit code 0 on --help", async () => {
      const code = await runCleanupCli(["--help"]);
      expect(code).toBe(0);
    });

    it("returns exit code 2 on invalid CLI argument", async () => {
      const code = await runCleanupCli(["--invalid-flag"]);
      expect(code).toBe(2);
    });

    it("returns exit code 0 on successful dry run", async () => {
      const mockDb: any = {
        finding: { count: vi.fn().mockResolvedValue(2) },
        auditLog: { count: vi.fn().mockResolvedValue(1) },
      };

      const code = await runCleanupCli(["--days=30"], mockDb);
      expect(code).toBe(0);
    });
  });
});
