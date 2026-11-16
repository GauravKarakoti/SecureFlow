import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DRIFT_ARGS,
  describePrismaDiffResult,
  runPrismaDiff,
} from "../scripts/check-prisma-drift.mjs";

describe("Prisma Schema Drift Check (#1691)", () => {
  const rootDir = process.cwd();
  const packageJsonPath = path.join(rootDir, "package.json");
  const ciWorkflowPath = path.join(rootDir, ".github", "workflows", "ci.yml");
  const contributingPath = path.join(rootDir, "CONTRIBUTING.md");
  const prismaReadmePath = path.join(rootDir, "prisma", "README.md");
  const schemaPath = path.join(rootDir, "prisma", "schema.prisma");

  describe("npm scripts configuration", () => {
    it("defines the db:check-drift script in package.json", () => {
      expect(fs.existsSync(packageJsonPath)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

      expect(pkg.scripts).toHaveProperty("db:check-drift");
      const script = pkg.scripts["db:check-drift"];
      expect(script).toBe("node scripts/check-prisma-drift.mjs");
      expect(DRIFT_ARGS).toEqual([
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ]);
    });
  });

  describe("CI workflow configuration (.github/workflows/ci.yml)", () => {
    it("configures the prisma-drift-check job with PostgreSQL 16 service and shadow db", () => {
      expect(fs.existsSync(ciWorkflowPath)).toBe(true);
      const ciContent = fs.readFileSync(ciWorkflowPath, "utf8");

      expect(ciContent).toContain("prisma-drift-check:");
      expect(ciContent).toContain("name: Prisma Schema Drift Check");
      expect(ciContent).toContain("image: postgres:16");
      expect(ciContent).toContain(
        "SHADOW_DATABASE_URL: postgresql://ci:ci@localhost:5432/secureflow_shadow",
      );
      expect(ciContent).toContain("CREATE DATABASE secureflow_shadow");
      expect(ciContent).toContain("npm run db:check-drift");
      expect(ciContent).toContain(
        "Schema drift detected. Run 'npx prisma migrate dev --name <change>' and commit the new migration.",
      );
    });

    it("ensures release job depends on prisma-drift-check", () => {
      const ciContent = fs.readFileSync(ciWorkflowPath, "utf8");
      const releaseJobIndex = ciContent.indexOf("release:");
      expect(releaseJobIndex).toBeGreaterThan(-1);

      const releaseSection = ciContent.slice(releaseJobIndex);
      expect(releaseSection).toContain("prisma-drift-check");
    });
  });

  describe("Documentation", () => {
    it("documents db:check-drift in CONTRIBUTING.md setup and PR checklist", () => {
      expect(fs.existsSync(contributingPath)).toBe(true);
      const contributingContent = fs.readFileSync(contributingPath, "utf8");

      expect(contributingContent).toContain("npm run db:check-drift");
      expect(contributingContent).toMatch(/- \[[ x]\] Run `npm run db:check-drift`/);
    });

    it("documents db:check-drift in prisma/README.md", () => {
      expect(fs.existsSync(prismaReadmePath)).toBe(true);
      const prismaReadmeContent = fs.readFileSync(prismaReadmePath, "utf8");

      expect(prismaReadmeContent).toContain("npm run db:check-drift");
    });
  });

  describe("Prisma migrate diff exit code contract", () => {
    it("exits with 0 when comparing schema to itself (no drift)", () => {
      expect(fs.existsSync(schemaPath)).toBe(true);
      const res = runPrismaDiff(
        [
          "migrate",
          "diff",
          "--from-schema",
          "prisma/schema.prisma",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code",
        ],
        { timeoutMs: 20_000 },
      );

      expect(res.status, describePrismaDiffResult(res, 20_000).message).toBe(0);
      expect(res.stdout).toContain("No difference detected");
    }, 30000);

    it("exits with 2 when diff detects unmigrated changes", () => {
      expect(fs.existsSync(schemaPath)).toBe(true);
      const res = runPrismaDiff(
        ["migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--exit-code"],
        { timeoutMs: 20_000 },
      );

      expect(res.status, describePrismaDiffResult(res, 20_000).message).toBe(2);
      expect(res.stdout).toContain("[+] Added");
    }, 30000);

    it("passes a process timeout and reports timeouts separately from schema drift", () => {
      const timedOut = Object.assign(new Error("process timed out"), { code: "ETIMEDOUT" });
      const spawn = vi.fn((command: string, args: string[], options: { timeout: number }) => {
        expect(command).toBe(process.execPath);
        expect(args).toHaveLength(1);
        expect(options.timeout).toBe(1234);
        return { status: null, error: timedOut, stdout: "", stderr: "" };
      });
      const result = runPrismaDiff([], { timeoutMs: 1234, spawn });

      expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 1234, encoding: "utf8" });
      expect(describePrismaDiffResult(result, 1234)).toMatchObject({
        exitCode: 124,
        message: expect.stringContaining("timed out"),
      });
    });

    it("reports non-drift Prisma failures with their cause", () => {
      const result = describePrismaDiffResult({ status: 1, stderr: "connection refused" });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("connection refused");
      expect(result.message).toContain("shadow database permissions");
    });

    it("redacts database credentials from Prisma diagnostics", () => {
      const result = describePrismaDiffResult({
        status: 1,
        stderr: "connection failed: postgresql://alice:secret@localhost:5432/secureflow",
      });
      expect(result.message).toContain("postgresql://[redacted]@localhost");
      expect(result.message).not.toContain("secret");
    });
  });
});
