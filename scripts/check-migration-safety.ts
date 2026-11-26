import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration Safety Checker for Prisma Migrations (#2104)
 *
 * Scans new migration SQL for destructive statements:
 * - DROP TABLE
 * - DROP COLUMN
 * - ALTER COLUMN ... TYPE
 * - RENAME COLUMN ... TO ...
 * - RENAME TO ...
 *
 * Fails CI unless the migration contains an approved marker comment with a reason:
 *   -- @secureflow-allow-destructive: <reason>
 *   or
 *   -- @allow-destructive: <reason>
 */

export const SAFE_MIGRATION_DOCS_URL =
  "https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/safe-migrations.md";

export const APPROVED_MARKER_REGEX =
  /(?:--|\/\*)\s*@(?:secureflow-)?allow-destructive:\s*(.+?)(?:\*\/|$)/im;

export interface DestructiveStatement {
  type: "DROP TABLE" | "DROP COLUMN" | "ALTER COLUMN TYPE" | "RENAME";
  statement: string;
  lineNumber: number;
}

export interface MigrationScanResult {
  filePath: string;
  isDestructive: boolean;
  destructiveStatements: DestructiveStatement[];
  approved: boolean;
  approvalReason: string | null;
}

/**
 * Strips comments from SQL lines while tracking comment contents for approval markers.
 */
export function extractApprovalReason(sql: string): string | null {
  const match = sql.match(APPROVED_MARKER_REGEX);
  if (!match || !match[1]) return null;
  const reason = match[1].trim();
  return reason.length > 0 ? reason : null;
}

/**
 * Scans SQL string line-by-line for destructive statements.
 * Ignores comments and non-destructive statements.
 */
export function scanSqlForDestructiveOperations(sql: string): DestructiveStatement[] {
  const destructiveStatements: DestructiveStatement[] = [];
  const lines = sql.split(/\r?\n/);

  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const lineNumber = i + 1;

    // Handle block comments /* ... */
    if (inBlockComment) {
      const endCommentIdx = line.indexOf("*/");
      if (endCommentIdx !== -1) {
        line = line.slice(endCommentIdx + 2);
        inBlockComment = false;
      } else {
        continue;
      }
    }

    // Check for start of block comment
    while (line.includes("/*")) {
      const startIdx = line.indexOf("/*");
      const endIdx = line.indexOf("*/", startIdx + 2);
      if (endIdx !== -1) {
        line = line.slice(0, startIdx) + " " + line.slice(endIdx + 2);
      } else {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
    }

    // Strip line comments (-- ...)
    const lineCommentIdx = line.indexOf("--");
    if (lineCommentIdx !== -1) {
      line = line.slice(0, lineCommentIdx);
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1. DROP TABLE
    if (/\bDROP\s+TABLE\b/i.test(trimmed)) {
      destructiveStatements.push({
        type: "DROP TABLE",
        statement: trimmed,
        lineNumber,
      });
      continue;
    }

    // 2. DROP COLUMN
    if (/\bDROP\s+COLUMN\b/i.test(trimmed)) {
      destructiveStatements.push({
        type: "DROP COLUMN",
        statement: trimmed,
        lineNumber,
      });
      continue;
    }

    // 3. ALTER COLUMN ... TYPE / ALTER TABLE ... ALTER COLUMN ... TYPE
    if (
      /\bALTER\s+COLUMN\b[\s\S]*?\b(?:SET\s+DATA\s+)?TYPE\b/i.test(trimmed) ||
      /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+COLUMN\b[\s\S]*?\b(?:SET\s+DATA\s+)?TYPE\b/i.test(trimmed)
    ) {
      destructiveStatements.push({
        type: "ALTER COLUMN TYPE",
        statement: trimmed,
        lineNumber,
      });
      continue;
    }

    // 4. Renames (RENAME COLUMN, RENAME TO)
    if (
      /\bRENAME\s+COLUMN\b/i.test(trimmed) ||
      /\bRENAME\s+TO\b/i.test(trimmed) ||
      /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i.test(trimmed)
    ) {
      destructiveStatements.push({
        type: "RENAME",
        statement: trimmed,
        lineNumber,
      });
      continue;
    }
  }

  return destructiveStatements;
}

/**
 * Evaluates a single migration file or SQL content.
 */
export function checkMigrationSql(filePath: string, sql: string): MigrationScanResult {
  const destructiveStatements = scanSqlForDestructiveOperations(sql);
  const isDestructive = destructiveStatements.length > 0;
  const approvalReason = extractApprovalReason(sql);
  const approved = isDestructive ? Boolean(approvalReason) : true;

  return {
    filePath,
    isDestructive,
    destructiveStatements,
    approved,
    approvalReason,
  };
}

/**
 * Finds all migration.sql files in a directory or changed in git diff.
 */
export function findMigrationFiles(
  migrationsDir = "prisma/migrations",
  targetFiles?: string[],
): string[] {
  if (targetFiles && targetFiles.length > 0) {
    return targetFiles.filter(
      (f) => f.endsWith("migration.sql") && fs.existsSync(f) && fs.statSync(f).isFile(),
    );
  }

  if (!fs.existsSync(migrationsDir)) return [];

  const files: string[] = [];
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sqlFile = path.join(migrationsDir, entry.name, "migration.sql");
      if (fs.existsSync(sqlFile)) {
        files.push(sqlFile);
      }
    }
  }

  return files.sort();
}

/**
 * Gets newly added or modified migration.sql files from git diff against base branch.
 */
export function getChangedMigrationFiles(
  baseBranch = "origin/main",
  cwd = process.cwd(),
): string[] {
  try {
    const output = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    const changed = output
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.includes("prisma/migrations") && f.endsWith("migration.sql"))
      .filter((f) => fs.existsSync(path.join(cwd, f)));

    return changed;
  } catch {
    return [];
  }
}

export function runMigrationSafetyCheck(
  options: {
    files?: string[];
    baseBranch?: string;
    checkAll?: boolean;
    cwd?: string;
  } = {},
): {
  results: MigrationScanResult[];
  hasViolations: boolean;
  formattedOutput: string;
} {
  const cwd = options.cwd ?? process.cwd();
  let filesToCheck: string[] = [];

  if (options.files !== undefined) {
    filesToCheck = options.files;
  } else if (!options.checkAll) {
    filesToCheck = getChangedMigrationFiles(options.baseBranch ?? "origin/main", cwd);
  }

  // If no git diff found and not checkAll, fall back to checking target migrations or skip
  if (filesToCheck.length === 0 && options.checkAll) {
    filesToCheck = findMigrationFiles(path.join(cwd, "prisma/migrations"));
  }

  const results: MigrationScanResult[] = [];
  let hasViolations = false;
  const outputLines: string[] = [];

  if (filesToCheck.length === 0) {
    outputLines.push("ℹ️ No new or modified Prisma migrations detected.");
    return {
      results: [],
      hasViolations: false,
      formattedOutput: outputLines.join("\n"),
    };
  }

  outputLines.push(
    `🔍 Scanning ${filesToCheck.length} Prisma migration(s) for destructive changes...\n`,
  );

  for (const file of filesToCheck) {
    const fullPath = path.isAbsolute(file) ? file : path.join(cwd, file);
    if (!fs.existsSync(fullPath)) continue;

    const sql = fs.readFileSync(fullPath, "utf8");
    const scan = checkMigrationSql(file, sql);
    results.push(scan);

    if (scan.isDestructive) {
      if (scan.approved) {
        outputLines.push(`✅ [APPROVED DESTRUCTIVE] ${file}`);
        outputLines.push(`   Reason: ${scan.approvalReason}`);
        for (const st of scan.destructiveStatements) {
          outputLines.push(`   - Line ${st.lineNumber}: [${st.type}] ${st.statement}`);
        }
        outputLines.push("");
      } else {
        hasViolations = true;
        outputLines.push(`❌ [UNAPPROVED DESTRUCTIVE] ${file}`);
        outputLines.push(
          `   Error: Destructive statement(s) detected without an approved reason marker.`,
        );
        for (const st of scan.destructiveStatements) {
          outputLines.push(`   - Line ${st.lineNumber}: [${st.type}] ${st.statement}`);
        }
        outputLines.push("");
      }
    } else {
      outputLines.push(`✅ [SAFE] ${file}`);
    }
  }

  if (hasViolations) {
    outputLines.push("──────────────────────────────────────────────────────────");
    outputLines.push("🚨 Migration safety check FAILED!");
    outputLines.push(
      "Destructive schema operations (DROP TABLE, DROP COLUMN, ALTER COLUMN TYPE, RENAME)",
    );
    outputLines.push("can destroy production data or cause downtime during rolling deployments.");
    outputLines.push("");
    outputLines.push("If this destructive migration is intentional and safe:");
    outputLines.push("1. Follow the expand-and-contract pattern described in CONTRIBUTING.md.");
    outputLines.push("2. Add an approved marker comment to the migration SQL:");
    outputLines.push(
      "   -- @secureflow-allow-destructive: <Reason why this destructive change is safe>",
    );
    outputLines.push("");
    outputLines.push(`📖 Safe migration guidance: ${SAFE_MIGRATION_DOCS_URL}`);
    outputLines.push("──────────────────────────────────────────────────────────");
  } else {
    outputLines.push("\n✨ All scanned migrations are safe or explicitly approved.");
  }

  return {
    results,
    hasViolations,
    formattedOutput: outputLines.join("\n"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const checkAll = process.argv.includes("--all");
  const baseBranchArg = process.argv.find((a) => a.startsWith("--base="))?.slice(7);
  const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  const outcome = runMigrationSafetyCheck({
    files: files.length > 0 ? files : undefined,
    baseBranch: baseBranchArg,
    checkAll,
  });

  console.log(outcome.formattedOutput);
  if (outcome.hasViolations) {
    process.exit(1);
  }
}
