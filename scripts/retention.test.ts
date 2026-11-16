import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs, runRetentionCli } from "./retention";
import {
  RETENTION_RULES,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  parseRetentionDays,
  resolveRetentionPolicy,
  retentionFor,
  RetentionConfigError,
} from "../src/lib/retention/policy";
import { PROTECTED_TRIAGE_STATUSES, REDACTED_SNIPPET } from "../src/lib/retention/purge";

describe("scripts/retention.ts - CLI and Data Deletion Boundaries (#1330)", () => {
  describe("CLI Argument Parsing (parseArgs)", () => {
    it("defaults to dry-run mode when no arguments are provided", () => {
      const options = parseArgs([]);
      expect(options.dryRun).toBe(true);
      expect(options.help).toBe(false);
      expect(options.only).toBeUndefined();
    });

    it("enables apply mode when --apply is passed", () => {
      const options = parseArgs(["--apply"]);
      expect(options.dryRun).toBe(false);
    });

    it("explicitly supports --dry-run", () => {
      const options = parseArgs(["--dry-run"]);
      expect(options.dryRun).toBe(true);
    });

    it("parses single and multiple --only targets", () => {
      const single = parseArgs(["--only=auditLog"]);
      expect(single.only).toEqual(["auditLog"]);

      const multiple = parseArgs(["--only=auditLog", "--only=webhookEvent"]);
      expect(multiple.only).toEqual(["auditLog", "webhookEvent"]);
    });

    it("rejects unknown --only targets with helpful error", () => {
      expect(() => parseArgs(["--only=unknownTable"])).toThrow(
        /Unknown --only target "unknownTable"/,
      );
    });

    it("parses valid --batch-size values", () => {
      const options = parseArgs(["--batch-size=250"]);
      expect(options.batchSize).toBe(250);
    });

    it("rejects invalid or out-of-range --batch-size values", () => {
      expect(() => parseArgs(["--batch-size=0"])).toThrow(/between 1 and 10000/);
      expect(() => parseArgs(["--batch-size=20000"])).toThrow(/between 1 and 10000/);
      expect(() => parseArgs(["--batch-size=abc"])).toThrow(/whole number/);
    });

    it("recognizes --help and -h flags", () => {
      expect(parseArgs(["--help"]).help).toBe(true);
      expect(parseArgs(["-h"]).help).toBe(true);
    });

    it("rejects unrecognized arguments and prevents typo accidents", () => {
      expect(() => parseArgs(["--aply"])).toThrow(/Unrecognised argument "--aply"/);
    });
  });

  describe("Data Deletion Boundaries (docs/data-retention.md)", () => {
    it("verifies findingSnippet retention boundary is 90 days and redacts code", () => {
      const rule = retentionFor("findingSnippet");
      expect(rule.defaultDays).toBe(90);
      expect(rule.envVar).toBe("FINDING_SNIPPET_REDACT_DAYS");
      expect(REDACTED_SNIPPET).toBe("[REDACTED — retention policy]");
      expect(PROTECTED_TRIAGE_STATUSES).toContain("OPEN");
    });

    it("verifies webhookEvent retention boundary is 30 days", () => {
      const rule = retentionFor("webhookEvent");
      expect(rule.defaultDays).toBe(30);
      expect(rule.envVar).toBe("WEBHOOK_EVENT_RETENTION_DAYS");
    });

    it("verifies scanResult retention boundary is 180 days", () => {
      const rule = retentionFor("scanResult");
      expect(rule.defaultDays).toBe(180);
      expect(rule.envVar).toBe("SCAN_RESULT_RETENTION_DAYS");
    });

    it("verifies auditLog retention boundary is 365 days", () => {
      const rule = retentionFor("auditLog");
      expect(rule.defaultDays).toBe(365);
      expect(rule.envVar).toBe("AUDIT_LOG_RETENTION_DAYS");
    });

    it("enforces retention boundary constraints (1 to 3650 days)", () => {
      const rule = RETENTION_RULES[0];
      expect(MIN_RETENTION_DAYS).toBe(1);
      expect(MAX_RETENTION_DAYS).toBe(3650);

      expect(() => parseRetentionDays(rule, "0")).toThrow(RetentionConfigError);
      expect(() => parseRetentionDays(rule, "3651")).toThrow(RetentionConfigError);
      expect(() => parseRetentionDays(rule, "non-numeric")).toThrow(RetentionConfigError);
      expect(parseRetentionDays(rule, "60")).toBe(60);
      expect(parseRetentionDays(rule, undefined)).toBe(rule.defaultDays);
    });

    it("computes deterministic cutoff timestamps matching policy days", () => {
      const fixedNow = new Date("2026-10-15T12:00:00.000Z");
      const resolved = resolveRetentionPolicy({}, fixedNow);

      const auditRule = resolved.find((r) => r.target === "auditLog")!;
      const expectedAuditCutoff = new Date(fixedNow.getTime() - 365 * 24 * 60 * 60 * 1000);
      expect(auditRule.cutoff.toISOString()).toBe(expectedAuditCutoff.toISOString());

      const webhookRule = resolved.find((r) => r.target === "webhookEvent")!;
      const expectedWebhookCutoff = new Date(fixedNow.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(webhookRule.cutoff.toISOString()).toBe(expectedWebhookCutoff.toISOString());
    });
  });

  describe("Execution & Error Exit Codes (runRetentionCli)", () => {
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        finding: {
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        webhookEvent: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        scanResult: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        auditLog: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
        $transaction: vi.fn().mockImplementation((fn: any) => fn(mockPrisma)),
      };
    });

    it("returns exit code 0 on --help", async () => {
      const code = await runRetentionCli(["--help"], mockPrisma);
      expect(code).toBe(0);
    });

    it("returns exit code 2 on invalid CLI arguments", async () => {
      const code = await runRetentionCli(["--invalid-argument"], mockPrisma);
      expect(code).toBe(2);
    });

    it("returns exit code 0 on successful dry run", async () => {
      const code = await runRetentionCli(["--dry-run", "--only=webhookEvent"], mockPrisma);
      expect(code).toBe(0);
    });
    it("never writes anything during a dry run", async () => {
      const code = await runRetentionCli([], mockPrisma);

      expect(code).toBe(0);
      expect(mockPrisma.finding.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.webhookEvent.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.scanResult.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.deleteMany).not.toHaveBeenCalled();
    });

    it("--only restricts the run to the named target", async () => {
      const code = await runRetentionCli(["--only=auditLog", "--days=30"], mockPrisma);

      expect(code).toBe(0);
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalled();
      expect(mockPrisma.webhookEvent.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.scanResult.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.finding.findMany).not.toHaveBeenCalled();
    });
  });
});
