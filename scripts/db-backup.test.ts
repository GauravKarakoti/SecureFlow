import { describe, it, expect } from "vitest";
import { parseArgs as parseBackupArgs } from "./db-backup";
import { parseArgs as parseRestoreArgs } from "./db-restore";
import { parseArgs as parseVerifyArgs } from "./db-verify-backup";

describe("Database Backup & Restore CLI Scripts (#1895)", () => {
  describe("scripts/db-backup.ts argument parsing", () => {
    it("parses defaults when no arguments are provided", () => {
      const args = parseBackupArgs([]);
      expect(args.help).toBe(false);
      expect(args.outputDir).toBeUndefined();
      expect(args.outputFile).toBeUndefined();
    });

    it("parses --output and --dir flags", () => {
      const args = parseBackupArgs(["--output=backups/custom.dump", "--dir=/tmp/backups"]);
      expect(args.outputFile).toBe("backups/custom.dump");
      expect(args.outputDir).toBe("/tmp/backups");
    });

    it("parses --help and -h flags", () => {
      expect(parseBackupArgs(["--help"]).help).toBe(true);
      expect(parseBackupArgs(["-h"]).help).toBe(true);
    });

    it("rejects unknown arguments with helpful error", () => {
      expect(() => parseBackupArgs(["--unknown-flag"])).toThrow(/Unrecognised argument/);
    });
  });

  describe("scripts/db-restore.ts argument parsing", () => {
    it("parses defaults", () => {
      const args = parseRestoreArgs([]);
      expect(args.force).toBe(false);
      expect(args.help).toBe(false);
      expect(args.file).toBeUndefined();
    });

    it("parses --file and --force flags", () => {
      const args = parseRestoreArgs(["--file=backups/snapshot.dump", "--force"]);
      expect(args.file).toBe("backups/snapshot.dump");
      expect(args.force).toBe(true);
    });

    it("parses --help flag", () => {
      expect(parseRestoreArgs(["--help"]).help).toBe(true);
    });

    it("rejects unknown arguments", () => {
      expect(() => parseRestoreArgs(["--invalid"])).toThrow(/Unrecognised argument/);
    });
  });

  describe("scripts/db-verify-backup.ts argument parsing", () => {
    it("parses defaults", () => {
      const args = parseVerifyArgs([]);
      expect(args.help).toBe(false);
      expect(args.keepTemp).toBe(false);
      expect(args.file).toBeUndefined();
      expect(args.tempDb).toBeUndefined();
    });

    it("parses --file, --temp-db, and --keep-temp flags", () => {
      const args = parseVerifyArgs([
        "--file=backups/latest.dump",
        "--temp-db=test_verification_db",
        "--keep-temp",
      ]);
      expect(args.file).toBe("backups/latest.dump");
      expect(args.tempDb).toBe("test_verification_db");
      expect(args.keepTemp).toBe(true);
    });

    it("parses --help flag", () => {
      expect(parseVerifyArgs(["--help"]).help).toBe(true);
    });

    it("rejects unknown arguments", () => {
      expect(() => parseVerifyArgs(["--fake"])).toThrow(/Unrecognised argument/);
    });
  });
});
