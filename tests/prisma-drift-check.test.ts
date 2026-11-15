import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
      expect(script).toContain("prisma migrate diff");
      expect(script).toContain("--from-migrations prisma/migrations");
      expect(script).toContain("--to-schema prisma/schema.prisma");
      expect(script).toContain("--exit-code");
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
      expect(contributingContent).toContain("SHADOW_DATABASE_URL");
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
      const isWindows = process.platform === "win32";
      const cmd = isWindows ? "cmd.exe" : "npx";
      const args = isWindows
        ? [
            "/c",
            "npx",
            "prisma",
            "migrate",
            "diff",
            "--from-schema",
            "prisma/schema.prisma",
            "--to-schema",
            "prisma/schema.prisma",
            "--exit-code",
          ]
        : [
            "prisma",
            "migrate",
            "diff",
            "--from-schema",
            "prisma/schema.prisma",
            "--to-schema",
            "prisma/schema.prisma",
            "--exit-code",
          ];

      const res = spawnSync(cmd, args, {
        cwd: rootDir,
        encoding: "utf8",
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("No difference detected");
    });

    it("exits with 2 when diff detects unmigrated changes", () => {
      expect(fs.existsSync(schemaPath)).toBe(true);
      const isWindows = process.platform === "win32";
      const cmd = isWindows ? "cmd.exe" : "npx";
      const args = isWindows
        ? [
            "/c",
            "npx",
            "prisma",
            "migrate",
            "diff",
            "--from-empty",
            "--to-schema",
            "prisma/schema.prisma",
            "--exit-code",
          ]
        : [
            "prisma",
            "migrate",
            "diff",
            "--from-empty",
            "--to-schema",
            "prisma/schema.prisma",
            "--exit-code",
          ];

      const res = spawnSync(cmd, args, {
        cwd: rootDir,
        encoding: "utf8",
      });

      expect(res.status).toBe(2);
      expect(res.stdout).toContain("[+] Added");
    });
  });
});
