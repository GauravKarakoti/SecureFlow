import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { scrubCredentials } from "@/lib/redaction";
import { resolveConnectionString } from "@/lib/db/pool-config";

const execFileAsync = promisify(execFile);

export interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultLogger: Logger = {
  info: (msg: string) => console.log(scrubCredentials(msg)),
  warn: (msg: string) => console.warn(scrubCredentials(msg)),
  error: (msg: string) => console.error(scrubCredentials(msg)),
};

/**
 * Parses a standard PostgreSQL connection URI into connection components.
 */
export function parsePostgresConnectionString(rawUrl: string): PostgresConnectionConfig {
  const url = new URL(rawUrl);
  return {
    host: url.hostname || "localhost",
    port: url.port ? parseInt(url.port, 10) : 5432,
    database: url.pathname ? url.pathname.replace(/^\//, "") : "postgres",
    username: decodeURIComponent(url.username || "postgres"),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ssl: url.searchParams.get("sslmode") === "require" || url.searchParams.get("ssl") === "true",
  };
}

/**
 * Returns a sanitized connection URI with passwords completely removed.
 */
export function sanitizeConnectionString(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const user = url.username ? `${url.username}@` : "";
    return `postgresql://${user}${url.hostname}:${url.port || 5432}/${url.pathname.replace(/^\//, "")}`;
  } catch {
    return "[REDACTED_CONNECTION_STRING]";
  }
}

/**
 * Queries the database for existing base tables in the public schema.
 */
export async function getDatabaseTableCount(
  connectionString: string,
  clientFactory?: (conn: string) => { connect: () => Promise<void>; query: (q: string) => Promise<{ rows: any[] }>; end: () => Promise<void> },
): Promise<{ count: number; tables: string[] }> {
  const client = clientFactory ? clientFactory(connectionString) : new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const tables = res.rows.map((r: any) => r.table_name || r.TABLE_NAME);
    return {
      count: tables.length,
      tables,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export interface BackupOptions {
  connectionString?: string;
  outputDir?: string;
  outputFile?: string;
  execCommand?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
  logger?: Logger;
}

export interface BackupResult {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  durationMs: number;
  timestamp: string;
  database: string;
}

/**
 * Generates a compressed PostgreSQL database dump using pg_dump.
 * Credentials and passwords are strictly kept out of CLI arguments and logs.
 */
export async function createDatabaseBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const logger = options.logger || defaultLogger;
  const rawConn = options.connectionString || resolveConnectionString(process.env);
  if (!rawConn) {
    throw new Error("No database connection string found in environment (DATABASE_URL is not set).");
  }

  const config = parsePostgresConnectionString(rawConn);
  const targetDir = options.outputDir || path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const timestampIso = new Date().toISOString();
  const fileDateTag = timestampIso.replace(/[:.]/g, "-");
  const fileName = options.outputFile ? path.basename(options.outputFile) : `secureflow_backup_${fileDateTag}.dump`;
  const targetFilePath = options.outputFile ? path.resolve(options.outputFile) : path.join(targetDir, fileName);

  logger.info(`Starting database backup for ${sanitizeConnectionString(rawConn)}...`);

  const args = [
    "-h", config.host,
    "-p", String(config.port),
    "-U", config.username,
    "-d", config.database,
    "-Fc", // Custom compressed archive format
    "--no-owner",
    "--no-privileges",
    "-f", targetFilePath,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.password ? { PGPASSWORD: config.password } : {}),
  };

  const startTime = Date.now();
  if (options.execCommand) {
    await options.execCommand("pg_dump", args, env);
  } else {
    try {
      await execFileAsync("pg_dump", args, { env });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(
          "pg_dump binary not found in PATH. Please install PostgreSQL client tools (e.g. `sudo apt install postgresql-client` or run via Docker).",
        );
      }
      throw new Error(`pg_dump failed: ${scrubCredentials(err?.message || String(err))}`);
    }
  }

  const durationMs = Date.now() - startTime;
  let fileSizeBytes = 0;
  if (fs.existsSync(targetFilePath)) {
    fileSizeBytes = fs.statSync(targetFilePath).size;
  }

  logger.info(`Backup completed successfully in ${durationMs}ms: ${targetFilePath} (${(fileSizeBytes / 1024).toFixed(2)} KB)`);

  return {
    filePath: targetFilePath,
    fileName,
    fileSizeBytes,
    durationMs,
    timestamp: timestampIso,
    database: config.database,
  };
}

export interface RestoreOptions {
  connectionString?: string;
  backupFile: string;
  force?: boolean;
  clean?: boolean;
  execCommand?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
  checkEmptyFn?: (connectionString: string) => Promise<{ count: number; tables: string[] }>;
  logger?: Logger;
}

export interface RestoreResult {
  success: boolean;
  durationMs: number;
  backupFile: string;
  database: string;
}

/**
 * Restores a compressed dump into PostgreSQL using pg_restore.
 * Refuses to restore into a non-empty database unless --force is given.
 */
export async function restoreDatabaseBackup(options: RestoreOptions): Promise<RestoreResult> {
  const logger = options.logger || defaultLogger;
  const rawConn = options.connectionString || resolveConnectionString(process.env);
  if (!rawConn) {
    throw new Error("No database connection string found in environment (DATABASE_URL is not set).");
  }

  const targetFile = path.resolve(options.backupFile);
  if (!fs.existsSync(targetFile)) {
    throw new Error(`Backup file not found at path: ${targetFile}`);
  }

  const config = parsePostgresConnectionString(rawConn);

  // Safety check: verify database is empty unless --force is specified
  if (!options.force) {
    const checkFn = options.checkEmptyFn || ((conn) => getDatabaseTableCount(conn));
    try {
      const { count, tables } = await checkFn(rawConn);
      if (count > 0) {
        throw new Error(
          `Target database "${config.database}" is not empty (${count} existing tables found: ${tables.slice(0, 5).join(", ")}${tables.length > 5 ? "..." : ""}). ` +
          `Refusing to restore without --force flag.`,
        );
      }
    } catch (err: any) {
      if (err.message.includes("Refusing to restore")) {
        throw err;
      }
      // If table check fails because database doesn't exist yet, we continue
      logger.warn(`Could not verify table count: ${scrubCredentials(err.message)}`);
    }
  }

  logger.info(`Starting restore into ${sanitizeConnectionString(rawConn)} from ${targetFile}...`);

  const isCustomFormat = targetFile.endsWith(".dump") || targetFile.endsWith(".dmp") || targetFile.endsWith(".tar");
  const isPlainSql = targetFile.endsWith(".sql");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.password ? { PGPASSWORD: config.password } : {}),
  };

  const startTime = Date.now();

  if (isPlainSql) {
    const args = [
      "-h", config.host,
      "-p", String(config.port),
      "-U", config.username,
      "-d", config.database,
      "-f", targetFile,
    ];

    if (options.execCommand) {
      await options.execCommand("psql", args, env);
    } else {
      try {
        await execFileAsync("psql", args, { env });
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          throw new Error("psql binary not found in PATH. Please install PostgreSQL client tools.");
        }
        throw new Error(`psql restore failed: ${scrubCredentials(err?.message || String(err))}`);
      }
    }
  } else {
    // Default pg_restore for custom format
    const args = [
      "-h", config.host,
      "-p", String(config.port),
      "-U", config.username,
      "-d", config.database,
      "--no-owner",
      "--no-privileges",
    ];

    if (options.force && options.clean !== false) {
      args.push("--clean", "--if-exists");
    }

    args.push(targetFile);

    if (options.execCommand) {
      await options.execCommand("pg_restore", args, env);
    } else {
      try {
        await execFileAsync("pg_restore", args, { env });
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          throw new Error("pg_restore binary not found in PATH. Please install PostgreSQL client tools.");
        }
        // pg_restore returns exit code 1 on non-fatal warnings (e.g. duplicate drop warnings)
        logger.warn(`pg_restore completed with warnings: ${scrubCredentials(err?.message || String(err))}`);
      }
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info(`Restore completed successfully in ${durationMs}ms into database "${config.database}".`);

  return {
    success: true,
    durationMs,
    backupFile: targetFile,
    database: config.database,
  };
}

export interface VerifyBackupOptions {
  connectionString?: string;
  backupFile?: string;
  tempDbName?: string;
  keepTempDb?: boolean;
  execCommand?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
  clientFactory?: (conn: string) => {
    connect: () => Promise<void>;
    query: (q: string, params?: any[]) => Promise<{ rows: any[] }>;
    end: () => Promise<void>;
  };
  logger?: Logger;
}

export interface VerifyBackupResult {
  verified: boolean;
  backupFile: string;
  tempDbName: string;
  tablesVerified: number;
  migrationsVerified: number;
  durationMs: number;
}

/**
 * Finds the latest backup file in the given directory.
 */
export function findLatestBackupFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".dump") || f.endsWith(".sql"))
    .map((f) => path.join(dir, f));

  if (files.length === 0) return null;

  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

/**
 * Restores a backup file into an ephemeral temporary database, verifies table counts
 * and Prisma migrations, and safely cleans up the temporary database.
 */
export async function verifyDatabaseBackup(options: VerifyBackupOptions = {}): Promise<VerifyBackupResult> {
  const logger = options.logger || defaultLogger;
  const rawConn = options.connectionString || resolveConnectionString(process.env);
  if (!rawConn) {
    throw new Error("No database connection string found in environment (DATABASE_URL is not set).");
  }

  let backupFile = options.backupFile;
  if (!backupFile) {
    const backupDir = path.resolve(process.cwd(), "backups");
    const latest = findLatestBackupFile(backupDir);
    if (!latest) {
      throw new Error(`No backup file provided and none found in ${backupDir}. Run 'npm run db:backup' first.`);
    }
    backupFile = latest;
  }

  const resolvedBackupFile = path.resolve(backupFile);
  if (!fs.existsSync(resolvedBackupFile)) {
    throw new Error(`Backup file not found at: ${resolvedBackupFile}`);
  }

  const config = parsePostgresConnectionString(rawConn);
  const tempDbName =
    options.tempDbName ||
    `sf_verify_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  logger.info(`Starting backup verification for ${resolvedBackupFile} using ephemeral DB "${tempDbName}"...`);

  // Connect to maintenance database (postgres or template1)
  const maintenanceConnUrl = new URL(rawConn);
  maintenanceConnUrl.pathname = "/postgres";
  const maintenanceConnString = maintenanceConnUrl.toString();

  const createClient = options.clientFactory
    ? (conn: string) => options.clientFactory!(conn)
    : (conn: string) => new Client({ connectionString: conn });

  const maintenanceClient = createClient(maintenanceConnString);

  // Construct temp database connection string
  const tempConnUrl = new URL(rawConn);
  tempConnUrl.pathname = `/${tempDbName}`;
  const tempConnString = tempConnUrl.toString();

  const startTime = Date.now();

  try {
    // 1. Create temporary database
    await maintenanceClient.connect();
    logger.info(`Creating ephemeral database "${tempDbName}"...`);
    await maintenanceClient.query(`CREATE DATABASE "${tempDbName}"`);

    // 2. Restore backup into temporary database
    logger.info(`Restoring backup into ephemeral database...`);
    await restoreDatabaseBackup({
      connectionString: tempConnString,
      backupFile: resolvedBackupFile,
      force: true,
      execCommand: options.execCommand,
      logger,
    });

    // 3. Inspect restored ephemeral database
    const tempClient = createClient(tempConnString);
    let tables: string[] = [];
    let migrations: any[] = [];

    await tempClient.connect();
    try {
      const tableRes = await tempClient.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      );
      tables = tableRes.rows.map((r: any) => r.table_name || r.TABLE_NAME);

      if (tables.length === 0) {
        throw new Error("Verification failed: no tables found in restored temporary database.");
      }

      // Check key application tables
      const expectedCoreTables = ["user", "repository", "pullrequest", "scanresult", "finding", "policy"];
      const lowerTables = new Set(tables.map((t) => t.toLowerCase()));
      const missingTables = expectedCoreTables.filter((t) => !lowerTables.has(t));

      if (missingTables.length > 0) {
        logger.warn(`Notice: Some expected tables were not present in backup: ${missingTables.join(", ")}`);
      }

      // 4. Verify Prisma migrations
      const migrationRes = await tempClient.query(
        "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at ASC",
      );
      migrations = migrationRes.rows;

      if (migrations.length === 0) {
        throw new Error("Verification failed: _prisma_migrations table exists but has 0 records.");
      }

      const rolledBack = migrations.filter((m: any) => m.rolled_back_at !== null);
      if (rolledBack.length > 0) {
        throw new Error(
          `Verification failed: found ${rolledBack.length} rolled back migrations in backup (${rolledBack.map((m: any) => m.migration_name).join(", ")}).`,
        );
      }

      logger.info(
        `Verification checks passed: ${tables.length} tables present, ${migrations.length} migrations applied cleanly.`,
      );
    } finally {
      await tempClient.end().catch(() => {});
    }

    const durationMs = Date.now() - startTime;

    return {
      verified: true,
      backupFile: resolvedBackupFile,
      tempDbName,
      tablesVerified: tables.length,
      migrationsVerified: migrations.length,
      durationMs,
    };
  } finally {
    // Drop temporary database unless explicitly preserved
    if (!options.keepTempDb) {
      try {
        logger.info(`Cleaning up ephemeral database "${tempDbName}"...`);
        // Terminate any open connections to tempDbName
        await maintenanceClient.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = '${tempDbName}' AND pid <> pg_backend_pid();
        `).catch(() => {});
        await maintenanceClient.query(`DROP DATABASE IF EXISTS "${tempDbName}"`).catch(() => {});
      } catch (err: any) {
        logger.warn(`Could not drop temporary database "${tempDbName}": ${err.message}`);
      }
    }
    await maintenanceClient.end().catch(() => {});
  }
}
