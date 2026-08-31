import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Leaderboard Prisma Index Optimization (#403)", () => {
  const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
  const migrationPath = path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260831010000_leaderboard_query_indexing",
    "migration.sql"
  );

  const schemaContent = fs.readFileSync(schemaPath, "utf-8");

  describe("Prisma Schema Compound Index Verification", () => {
    it("should define compound index @@index([authorLogin, state]) on PullRequest", () => {
      expect(schemaContent).toContain("@@index([authorLogin, state])");
    });

    it("should define compound index @@index([authorLogin, status]) on PullRequest", () => {
      expect(schemaContent).toContain("@@index([authorLogin, status])");
    });

    it("should define compound index @@index([authorLogin, authorAvatarUrl]) on PullRequest", () => {
      expect(schemaContent).toContain("@@index([authorLogin, authorAvatarUrl])");
    });

    it("should define compound index @@index([authorLogin, createdAt(sort: Desc)]) on PullRequest", () => {
      expect(schemaContent).toContain("@@index([authorLogin, createdAt(sort: Desc)])");
    });

    it("should define compound index @@index([scanResultId, fingerprint]) on Finding", () => {
      expect(schemaContent).toContain("@@index([scanResultId, fingerprint])");
    });

    it("should define compound index @@index([status, fingerprint]) on FindingTriage", () => {
      expect(schemaContent).toContain("@@index([status, fingerprint])");
    });

    it("should define compound index @@index([codename, githubLogin]) on User", () => {
      expect(schemaContent).toContain("@@index([codename, githubLogin])");
    });
  });

  describe("SQL Migration Verification", () => {
    it("should exist and contain CREATE INDEX statements for all leaderboard queries", () => {
      expect(fs.existsSync(migrationPath)).toBe(true);
      const sqlContent = fs.readFileSync(migrationPath, "utf-8");

      expect(sqlContent).toContain('CREATE INDEX "PullRequest_authorLogin_state_idx"');
      expect(sqlContent).toContain('CREATE INDEX "PullRequest_authorLogin_status_idx"');
      expect(sqlContent).toContain('CREATE INDEX "PullRequest_authorLogin_authorAvatarUrl_idx"');
      expect(sqlContent).toContain('CREATE INDEX "PullRequest_authorLogin_createdAt_idx"');
      expect(sqlContent).toContain('CREATE INDEX "Finding_scanResultId_fingerprint_idx"');
      expect(sqlContent).toContain('CREATE INDEX "FindingTriage_status_fingerprint_idx"');
      expect(sqlContent).toContain('CREATE INDEX "User_codename_githubLogin_idx"');
    });
  });
});
