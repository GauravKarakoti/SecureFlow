import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parsePostgresConnectionString,
  sanitizeConnectionString,
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
  findLatestBackupFile,
} from "./backup";

describe("Database Backup & Restore Module (#1895)", () => {
  const dummyConnString =
    "postgresql://myuser:superSecretPassword123@db.example.com:5433/sf_prod?sslmode=require";

  describe("parsePostgresConnectionString", () => {
    it("parses connection URL into host, port, user, password, and database", () => {
      const config = parsePostgresConnectionString(dummyConnString);
      expect(config.host).toBe("db.example.com");
      expect(config.port).toBe(5433);
      expect(config.username).toBe("myuser");
      expect(config.password).toBe("superSecretPassword123");
      expect(config.database).toBe("sf_prod");
      expect(config.ssl).toBe(true);
    });

    it("handles default port and unauthenticated URLs", () => {
      const config = parsePostgresConnectionString("postgresql://localhost/sf_dev");
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(5432);
      expect(config.username).toBe("postgres");
      expect(config.password).toBeUndefined();
      expect(config.database).toBe("sf_dev");
    });
  });

  describe("sanitizeConnectionString & password privacy", () => {
    it("strips password completely from connection string", () => {
      const sanitized = sanitizeConnectionString(dummyConnString);
      expect(sanitized).toBe("postgresql://myuser@db.example.com:5433/sf_prod");
      expect(sanitized).not.toContain("superSecretPassword123");
    });

    it("returns redacted placeholder on malformed URLs", () => {
      expect(sanitizeConnectionString("not-a-url")).toBe("[REDACTED_CONNECTION_STRING]");
    });
  });

  describe("createDatabaseBackup", () => {
    it("invokes pg_dump with custom format -Fc and passes password via PGPASSWORD", async () => {
      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const loggedMessages: string[] = [];
      const logger = {
        info: (msg: string) => loggedMessages.push(msg),
        warn: (msg: string) => loggedMessages.push(msg),
        error: (msg: string) => loggedMessages.push(msg),
      };

      const result = await createDatabaseBackup({
        connectionString: dummyConnString,
        outputDir: "test_backups",
        outputFile: "test_backups/test.dump",
        execCommand,
        logger,
      });

      expect(execCommand).toHaveBeenCalledTimes(1);
      const [cmd, args, env] = execCommand.mock.calls[0];

      expect(cmd).toBe("pg_dump");
      expect(args).toContain("-Fc");
      expect(args).toContain("--no-owner");
      expect(args).toContain("--no-privileges");
      expect(args).toContain("-h");
      expect(args).toContain("db.example.com");
      expect(args).toContain("-d");
      expect(args).toContain("sf_prod");

      // Password MUST NOT be in args
      expect(args.join(" ")).not.toContain("superSecretPassword123");

      // Password MUST be in env.PGPASSWORD
      expect(env.PGPASSWORD).toBe("superSecretPassword123");

      // Logs MUST NOT leak password
      const fullLog = loggedMessages.join(" ");
      expect(fullLog).not.toContain("superSecretPassword123");

      expect(result.database).toBe("sf_prod");
    });
  });

  describe("restoreDatabaseBackup", () => {
    const dummyBackupFile = path.resolve("test_backup.dump");

    beforeEach(() => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "statSync").mockReturnValue({ size: 1024, mtimeMs: Date.now() } as any);
    });

    it("refuses to restore into a non-empty database without --force", async () => {
      const checkEmptyFn = vi.fn().mockResolvedValue({
        count: 5,
        tables: ["User", "Repository", "ScanResult", "Finding", "Policy"],
      });
      const execCommand = vi.fn();

      await expect(
        restoreDatabaseBackup({
          connectionString: dummyConnString,
          backupFile: dummyBackupFile,
          force: false,
          checkEmptyFn,
          execCommand,
        }),
      ).rejects.toThrow(/not empty \(5 existing tables found.*Refusing to restore without --force/);

      expect(execCommand).not.toHaveBeenCalled();
    });

    it("proceeds with restore into a non-empty database when --force is provided", async () => {
      const checkEmptyFn = vi.fn();
      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const loggedMessages: string[] = [];
      const logger = {
        info: (msg: string) => loggedMessages.push(msg),
        warn: (msg: string) => loggedMessages.push(msg),
        error: (msg: string) => loggedMessages.push(msg),
      };

      const result = await restoreDatabaseBackup({
        connectionString: dummyConnString,
        backupFile: dummyBackupFile,
        force: true,
        checkEmptyFn,
        execCommand,
        logger,
      });

      expect(checkEmptyFn).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledTimes(1);

      const [cmd, args, env] = execCommand.mock.calls[0];
      expect(cmd).toBe("pg_restore");
      expect(args).toContain("--clean");
      expect(args).toContain("--if-exists");

      // Password MUST NOT be in args or logs
      expect(args.join(" ")).not.toContain("superSecretPassword123");
      expect(env.PGPASSWORD).toBe("superSecretPassword123");
      expect(loggedMessages.join(" ")).not.toContain("superSecretPassword123");

      expect(result.success).toBe(true);
      expect(result.database).toBe("sf_prod");
    });

    it("proceeds with restore into an empty database without --force", async () => {
      const checkEmptyFn = vi.fn().mockResolvedValue({ count: 0, tables: [] });
      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      const result = await restoreDatabaseBackup({
        connectionString: dummyConnString,
        backupFile: dummyBackupFile,
        force: false,
        checkEmptyFn,
        execCommand,
      });

      expect(checkEmptyFn).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it("uses psql instead of pg_restore for plain text .sql files", async () => {
      const checkEmptyFn = vi.fn().mockResolvedValue({ count: 0, tables: [] });
      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      await restoreDatabaseBackup({
        connectionString: dummyConnString,
        backupFile: "test_backup.sql",
        force: false,
        checkEmptyFn,
        execCommand,
      });

      const [cmd] = execCommand.mock.calls[0];
      expect(cmd).toBe("psql");
    });
  });

  describe("verifyDatabaseBackup", () => {
    beforeEach(() => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "statSync").mockReturnValue({ size: 1024, mtimeMs: Date.now() } as any);
    });

    it("creates ephemeral database, restores, verifies tables & migrations, and drops ephemeral DB", async () => {
      const maintenanceQueries: string[] = [];
      const tempQueries: string[] = [];

      const mockMaintenanceClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockImplementation(async (sql: string) => {
          maintenanceQueries.push(sql);
          return { rows: [] };
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const mockTempClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockImplementation(async (sql: string) => {
          tempQueries.push(sql);
          if (sql.includes("information_schema.tables")) {
            return {
              rows: [
                { table_name: "User" },
                { table_name: "Repository" },
                { table_name: "PullRequest" },
                { table_name: "ScanResult" },
                { table_name: "Finding" },
                { table_name: "Policy" },
                { table_name: "_prisma_migrations" },
              ],
            };
          }
          if (sql.includes("_prisma_migrations")) {
            return {
              rows: [
                { migration_name: "20260101_init", finished_at: new Date(), rolled_back_at: null },
                {
                  migration_name: "20260201_update",
                  finished_at: new Date(),
                  rolled_back_at: null,
                },
              ],
            };
          }
          return { rows: [] };
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const clientFactory = (conn: string) => {
        if (conn.includes("/postgres")) {
          return mockMaintenanceClient;
        }
        return mockTempClient;
      };

      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      const result = await verifyDatabaseBackup({
        connectionString: dummyConnString,
        backupFile: "test_backups/backup.dump",
        tempDbName: "sf_verify_test123",
        clientFactory,
        execCommand,
      });

      expect(result.verified).toBe(true);
      expect(result.tablesVerified).toBe(7);
      expect(result.migrationsVerified).toBe(2);

      // Verify maintenance client created the temp DB
      expect(
        maintenanceQueries.some((q) => q.includes('CREATE DATABASE "sf_verify_test123"')),
      ).toBe(true);

      // Verify maintenance client dropped the temp DB
      expect(
        maintenanceQueries.some((q) => q.includes('DROP DATABASE IF EXISTS "sf_verify_test123"')),
      ).toBe(true);
    });

    it("fails verification if restored database has 0 tables", async () => {
      const mockMaintenanceClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ rows: [] }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const mockTempClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("information_schema.tables")) {
            return { rows: [] }; // 0 tables
          }
          return { rows: [] };
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const clientFactory = (conn: string) =>
        conn.includes("/postgres") ? mockMaintenanceClient : mockTempClient;
      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      await expect(
        verifyDatabaseBackup({
          connectionString: dummyConnString,
          backupFile: "test_backups/empty.dump",
          tempDbName: "sf_verify_empty",
          clientFactory,
          execCommand,
        }),
      ).rejects.toThrow(/Verification failed: no tables found/);

      // Ephemeral DB is still dropped in finally block
      expect(mockMaintenanceClient.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP DATABASE IF EXISTS "sf_verify_empty"'),
      );
    });

    it("fails verification if migrations have rolled_back_at non-null", async () => {
      const mockMaintenanceClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ rows: [] }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const mockTempClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("information_schema.tables")) {
            return { rows: [{ table_name: "User" }] };
          }
          if (sql.includes("_prisma_migrations")) {
            return {
              rows: [
                {
                  migration_name: "20260101_broken",
                  finished_at: null,
                  rolled_back_at: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const clientFactory = (conn: string) =>
        conn.includes("/postgres") ? mockMaintenanceClient : mockTempClient;
      const execCommand = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      await expect(
        verifyDatabaseBackup({
          connectionString: dummyConnString,
          backupFile: "test_backups/broken.dump",
          tempDbName: "sf_verify_broken",
          clientFactory,
          execCommand,
        }),
      ).rejects.toThrow(/Verification failed: found 1 rolled back migrations/);
    });
  });
});
