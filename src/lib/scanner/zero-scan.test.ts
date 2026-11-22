import { describe, it, expect } from "vitest";
import { getZeroScanReason, formatZeroScanComment, type ZeroScanReason } from "./zero-scan";
import { SECUREFLOW_COMMENT_MARKER } from "@/lib/github/sticky-comment";

describe("zero-scan: getZeroScanReason", () => {
  describe("no changed files", () => {
    it("returns 'no changed files' for an empty diff (0 changed files)", () => {
      expect(getZeroScanReason([])).toBe("no changed files");
    });

    it("returns 'no changed files' when all files were removed / deleted", () => {
      const files = [
        { filename: "src/old-feature.ts", status: "removed" },
        { filename: "src/legacy.ts", status: "removed" },
      ];
      expect(getZeroScanReason(files)).toBe("no changed files");
    });
  });

  describe("unsupported file types", () => {
    it("returns 'unsupported file types' when files have no patch (binary files)", () => {
      const files = [
        { filename: "assets/logo.png", status: "added", patch: undefined },
        { filename: "docs/manual.pdf", status: "added", patch: "" },
      ];
      expect(getZeroScanReason(files)).toBe("unsupported file types");
    });

    it("returns 'unsupported file types' for markdown and documentation files", () => {
      const files = [
        { filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n+# Updated README" },
        {
          filename: "docs/architecture.md",
          status: "added",
          patch: "@@ -0,0 +1 @@\n+# Architecture",
        },
      ];
      expect(getZeroScanReason(files)).toBe("unsupported file types");
    });

    it("returns 'unsupported file types' for lockfiles, CSV, and image assets", () => {
      const files = [
        { filename: "package-lock.json", status: "modified", patch: "@@ -1 +1 @@\n+{\n+}" },
        { filename: "data/export.csv", status: "added", patch: "@@ -0,0 +1 @@\n+id,name" },
        { filename: "public/icon.svg", status: "added", patch: "@@ -0,0 +1 @@\n+<svg></svg>" },
      ];
      expect(getZeroScanReason(files)).toBe("unsupported file types");
    });

    it("returns 'unsupported file types' when files have no added lines (deletions only)", () => {
      const files = [
        { filename: "src/util.ts", status: "modified", patch: "@@ -1,2 +0,0 @@\n-line1\n-line2" },
      ];
      expect(getZeroScanReason(files)).toBe("unsupported file types");
    });
  });

  describe("all paths ignored", () => {
    it("returns 'all paths ignored' when files are in ignored directories", () => {
      const files = [
        {
          filename: "node_modules/pkg/index.js",
          status: "added",
          patch: "@@ -0,0 +1 @@\n+const x = 1;",
        },
        { filename: "dist/bundle.js", status: "modified", patch: "@@ -1 +1 @@\n+const y = 2;" },
        { filename: "build/output.js", status: "modified", patch: "@@ -1 +1 @@\n+const z = 3;" },
      ];
      expect(getZeroScanReason(files)).toBe("all paths ignored");
    });

    it("returns 'all paths ignored' when files match custom ignore rules (.secureflowignore)", () => {
      const files = [
        {
          filename: "src/generated/types.ts",
          status: "added",
          patch: "@@ -0,0 +1 @@\n+export type A = 1;",
        },
        {
          filename: "fixtures/sample.ts",
          status: "added",
          patch: "@@ -0,0 +1 @@\n+const val = 2;",
        },
      ];
      const customIgnores = ["src/generated/**", "fixtures/**"];
      expect(getZeroScanReason(files, customIgnores)).toBe("all paths ignored");
    });

    it("returns 'all paths ignored' when files match configuration file basenames", () => {
      const files = [
        { filename: "package.json", status: "modified", patch: '@@ -1 +1 @@\n+"name": "app"' },
        { filename: ".gitignore", status: "modified", patch: "@@ -1 +1 @@\n+dist/" },
      ];
      expect(getZeroScanReason(files)).toBe("all paths ignored");
    });

    it("returns 'all paths ignored' when code files match ignore rules alongside docs", () => {
      const files = [
        { filename: "src/ignored.ts", status: "modified", patch: "@@ -1 +1 @@\n+const a = 1;" },
        { filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n+# Docs" },
      ];
      expect(getZeroScanReason(files, ["src/ignored.ts"])).toBe("all paths ignored");
    });
  });
});

describe("zero-scan: formatZeroScanComment", () => {
  it("never includes success wording in zero scan report", () => {
    const reasons: ZeroScanReason[] = [
      "no changed files",
      "unsupported file types",
      "all paths ignored",
    ];

    for (const reason of reasons) {
      const comment = formatZeroScanComment(reason, { commitSha: "abc1234" });

      expect(comment).toContain(SECUREFLOW_COMMENT_MARKER);
      expect(comment).toContain("Nothing to scan");
      expect(comment).toContain(reason);
      expect(comment).toContain("Scanned commit: `abc1234`");

      // Acceptance criterion: Zero analyzed files never produces the success wording
      expect(comment).not.toContain("Scan completed successfully");
      expect(comment).not.toContain("No vulnerabilities found");
      expect(comment).not.toContain("✅");
    }
  });

  it("includes coverage notice when provided", () => {
    const comment = formatZeroScanComment("unsupported file types", {
      coverageNotice:
        "⚠️ 2 changed file(s) were not analysed because GitHub did not return a diff.",
    });

    expect(comment).toContain("Nothing to scan: unsupported file types.");
    expect(comment).toContain("⚠️ 2 changed file(s) were not analysed");
  });

  it("includes expired ignore rules and dismissal notices when provided", () => {
    const comment = formatZeroScanComment("all paths ignored", {
      cleanDismissedNotice: "\n\n🛡️ **1 previously dismissed** finding(s) were suppressed.",
      cleanRuleNotice:
        "\n\n🛡️ **2** finding(s) were suppressed by installation suppression rule(s).",
      cleanExpiredNotice:
        "\n\n### ⚠️ Expired Ignore Rules (1)\n\n- ⚠️ ignore rule `test/*` expired on 2026-01-01",
    });

    expect(comment).toContain("Nothing to scan: all paths ignored.");
    expect(comment).toContain("1 previously dismissed");
    expect(comment).toContain("Expired Ignore Rules (1)");
  });
});
