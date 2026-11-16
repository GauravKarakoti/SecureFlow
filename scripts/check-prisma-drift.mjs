import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
export const DRIFT_TIMEOUT_MS = 60_000;
export const DRIFT_ARGS = [
  "migrate",
  "diff",
  "--from-migrations",
  "prisma/migrations",
  "--to-schema",
  "prisma/schema.prisma",
  "--exit-code",
];

/** @typedef {{ status: number | null, error?: Error & { code?: string }, stdout?: string | null, stderr?: string | null, signal?: string | null }} PrismaProcessResult */

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number, spawn?: (command: string, args: string[], options: { cwd: string, encoding: "utf8", timeout: number, maxBuffer: number }) => PrismaProcessResult }} options
 * @returns {PrismaProcessResult}
 */
export function runPrismaDiff(
  args = DRIFT_ARGS,
  { timeoutMs = DRIFT_TIMEOUT_MS, spawn = spawnSync } = {},
) {
  return spawn(process.execPath, [prismaCli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
}

/** @param {PrismaProcessResult} result */
export function describePrismaDiffResult(result, timeoutMs = DRIFT_TIMEOUT_MS) {
  if (result.error?.code === "ETIMEDOUT") {
    return {
      exitCode: 124,
      message: `Prisma migrate diff timed out after ${timeoutMs / 1000}s. Check database connectivity and shadow database permissions. On Neon, a separate shadow URL is unnecessary when Prisma can create its temporary database; never point SHADOW_DATABASE_URL at the application database.`,
    };
  }
  if (result.status === 0) return { exitCode: 0, message: "No schema drift detected." };
  if (result.status === 2) {
    return {
      exitCode: 2,
      message:
        "Schema drift detected. Run 'npx prisma migrate dev --name <change>' and commit the new migration.",
    };
  }
  const reason =
    result.error?.message ||
    result.stderr?.trim() ||
    result.signal ||
    "No Prisma diagnostics were returned.";
  const safeReason = reason.replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, "$1[redacted]@");
  return {
    exitCode: 1,
    message: `Prisma migrate diff failed (exit ${result.status ?? "unknown"}). Check database connectivity, shadow database permissions, and the schema. ${safeReason.slice(0, 2000)}`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = runPrismaDiff();
  if (result.stdout) process.stdout.write(result.stdout);
  const outcome = describePrismaDiffResult(result);
  if (outcome.exitCode !== 0) console.error(outcome.message);
  process.exitCode = outcome.exitCode;
}
