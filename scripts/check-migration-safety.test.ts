import { describe, it, expect } from "vitest";
import {
  scanSqlForDestructiveOperations,
  extractApprovalReason,
  checkMigrationSql,
  runMigrationSafetyCheck,
  SAFE_MIGRATION_DOCS_URL,
} from "./check-migration-safety";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Migration Safety Scanner (#2104)", () => {
  describe("scanSqlForDestructiveOperations", () => {
    it("detects DROP TABLE statements", () => {
      const sql = `
        -- Create something
        CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
        DROP TABLE "OldTable";
      `;
      const findings = scanSqlForDestructiveOperations(sql);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.type).toBe("DROP TABLE");
      expect(findings[0]?.statement).toContain('DROP TABLE "OldTable"');
      expect(findings[0]?.lineNumber).toBe(4);
    });

    it("detects DROP COLUMN statements", () => {
      const sql = `
        ALTER TABLE "User" DROP COLUMN "deprecatedField";
      `;
      const findings = scanSqlForDestructiveOperations(sql);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.type).toBe("DROP COLUMN");
      expect(findings[0]?.statement).toContain('DROP COLUMN "deprecatedField"');
    });

    it("detects ALTER COLUMN ... TYPE and SET DATA TYPE statements", () => {
      const sql = `
        ALTER TABLE "Finding" ALTER COLUMN "details" TYPE VARCHAR(255);
        ALTER TABLE "Account" ALTER COLUMN "status" SET DATA TYPE INTEGER;
      `;
      const findings = scanSqlForDestructiveOperations(sql);
      expect(findings).toHaveLength(2);
      expect(findings[0]?.type).toBe("ALTER COLUMN TYPE");
      expect(findings[1]?.type).toBe("ALTER COLUMN TYPE");
    });

    it("detects table and column renames", () => {
      const sql = `
        ALTER TABLE "Finding" RENAME COLUMN "old_name" TO "new_name";
        ALTER TABLE "OldModel" RENAME TO "NewModel";
      `;
      const findings = scanSqlForDestructiveOperations(sql);
      expect(findings).toHaveLength(2);
      expect(findings[0]?.type).toBe("RENAME");
      expect(findings[1]?.type).toBe("RENAME");
    });

    it("ignores comments containing destructive keywords", () => {
      const sql = `
        -- This comment mentions DROP TABLE and DROP COLUMN
        /* Multi-line comment
           ALTER COLUMN type
           RENAME TO something
        */
        CREATE TABLE "SafeTable" ("id" TEXT PRIMARY KEY);
        ALTER TABLE "SafeTable" ADD COLUMN "new_field" TEXT;
      `;
      const findings = scanSqlForDestructiveOperations(sql);
      expect(findings).toHaveLength(0);
    });

    it("handles safe migrations with only additive statements", () => {
      const sql = `
        CREATE TABLE "AuditLog" ("id" TEXT PRIMARY KEY, "action" TEXT NOT NULL);
        CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
        ALTER TABLE "AuditLog" ADD COLUMN "metadata" JSONB;
        ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_user_fk" FOREIGN KEY ("userId") REFERENCES "User"("id");
      `;
      const findings = scanSqlForDestructiveOperations(sql);
      expect(findings).toHaveLength(0);
    });
  });

  describe("extractApprovalReason", () => {
    it("extracts reason from single-line comment marker -- @secureflow-allow-destructive: <reason>", () => {
      const sql = `
        -- @secureflow-allow-destructive: Dropping unreferenced column after expand-and-contract phase 3
        ALTER TABLE "Finding" DROP COLUMN "oldCol";
      `;
      const reason = extractApprovalReason(sql);
      expect(reason).toBe("Dropping unreferenced column after expand-and-contract phase 3");
    });

    it("extracts reason from block comment marker /* @allow-destructive: <reason> */", () => {
      const sql = `
        /* @allow-destructive: Table deprecated in v2.0 */
        DROP TABLE "OldFindings";
      `;
      const reason = extractApprovalReason(sql);
      expect(reason).toBe("Table deprecated in v2.0");
    });

    it("returns null when no marker is present or reason is empty", () => {
      expect(extractApprovalReason("DROP TABLE test;")).toBeNull();
      expect(extractApprovalReason("-- @secureflow-allow-destructive:    ")).toBeNull();
    });
  });

  describe("checkMigrationSql", () => {
    it("fails unmarked destructive migrations", () => {
      const sql = `ALTER TABLE "User" DROP COLUMN "token";`;
      const result = checkMigrationSql("migration.sql", sql);
      expect(result.isDestructive).toBe(true);
      expect(result.approved).toBe(false);
      expect(result.destructiveStatements).toHaveLength(1);
    });

    it("passes marked destructive migrations and extracts reason", () => {
      const sql = `
        -- @secureflow-allow-destructive: Column migrated to Token table
        ALTER TABLE "User" DROP COLUMN "token";
      `;
      const result = checkMigrationSql("migration.sql", sql);
      expect(result.isDestructive).toBe(true);
      expect(result.approved).toBe(true);
      expect(result.approvalReason).toBe("Column migrated to Token table");
    });

    it("passes completely safe migrations without markers", () => {
      const sql = `CREATE TABLE "Settings" ("id" TEXT PRIMARY KEY);`;
      const result = checkMigrationSql("migration.sql", sql);
      expect(result.isDestructive).toBe(false);
      expect(result.approved).toBe(true);
    });
  });

  describe("runMigrationSafetyCheck", () => {
    it("reports violations, link to safe migration docs, and offending statements for unmarked destructive migrations", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-migration-test-"));
      const migFile = path.join(tempDir, "migration.sql");
      fs.writeFileSync(migFile, 'ALTER TABLE "User" DROP COLUMN "password";\nDROP TABLE "OldTable";');

      const outcome = runMigrationSafetyCheck({ files: [migFile] });
      expect(outcome.hasViolations).toBe(true);
      expect(outcome.formattedOutput).toContain("[UNAPPROVED DESTRUCTIVE]");
      expect(outcome.formattedOutput).toContain("DROP COLUMN");
      expect(outcome.formattedOutput).toContain("DROP TABLE");
      expect(outcome.formattedOutput).toContain(SAFE_MIGRATION_DOCS_URL);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("passes and displays reason when destructive migration includes approval marker", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-migration-test-"));
      const migFile = path.join(tempDir, "migration.sql");
      fs.writeFileSync(
        migFile,
        '-- @secureflow-allow-destructive: Cleaning up scratch table\nDROP TABLE "Scratch";',
      );

      const outcome = runMigrationSafetyCheck({ files: [migFile] });
      expect(outcome.hasViolations).toBe(false);
      expect(outcome.formattedOutput).toContain("[APPROVED DESTRUCTIVE]");
      expect(outcome.formattedOutput).toContain("Cleaning up scratch table");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("reports message when no new migrations are found", () => {
      const outcome = runMigrationSafetyCheck({ files: [] });
      expect(outcome.hasViolations).toBe(false);
      expect(outcome.formattedOutput).toContain("No new or modified Prisma migrations detected");
    });
  });
});
