import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  isWorkflowFile,
  scanWorkflowFile,
  runWorkflowSecurityRules,
  RULE_IDS,
  extractWorkflowLines,
} from "./workflow-rules";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

describe("GitHub Actions Workflow Security Rules (#2002)", () => {
  describe("isWorkflowFile", () => {
    it("matches files under .github/workflows with .yml or .yaml extension", () => {
      expect(isWorkflowFile(".github/workflows/ci.yml")).toBe(true);
      expect(isWorkflowFile(".github/workflows/deploy.yaml")).toBe(true);
      expect(isWorkflowFile(".github/workflows/test.YML")).toBe(true);
      expect(isWorkflowFile("./.github/workflows/ci.yml")).toBe(true);
      expect(isWorkflowFile(".github\\workflows\\ci.yml")).toBe(true);
    });

    it("rejects files outside .github/workflows", () => {
      expect(isWorkflowFile("src/app.ts")).toBe(false);
      expect(isWorkflowFile("workflows/ci.yml")).toBe(false);
      expect(isWorkflowFile(".github/actions/setup/action.yml")).toBe(false);
      expect(isWorkflowFile(".github/workflows/notes.txt")).toBe(false);
      expect(isWorkflowFile("")).toBe(false);
    });
  });

  describe("Rule 1: pull_request_target with head checkout", () => {
    const vulnContent = readFixture("rule1-pr-target-checkout.vulnerable.yml");
    const safeContent = readFixture("rule1-pr-target-checkout.safe.yml");

    it("flags vulnerable pull_request_target head checkout with CRITICAL severity and line number", () => {
      const findings = scanWorkflowFile(".github/workflows/pr-target.yml", vulnContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.PULL_REQUEST_TARGET_CHECKOUT),
      );

      expect(targetFindings.length).toBeGreaterThan(0);
      const finding = targetFindings[0];
      expect(finding.severity).toBe("CRITICAL");
      expect(finding.type).toBe("Vulnerability");
      expect(finding.description).toContain(RULE_IDS.PULL_REQUEST_TARGET_CHECKOUT);
      expect(finding.description).toContain("Fix:");
      expect(finding.remediation).toBeTruthy();
      expect(finding.lineStart).toBe(16);
      expect(finding.codeSnippet).toContain("github.event.pull_request.head.sha");
    });

    it("passes safe pull_request_target checking out base branch", () => {
      const findings = scanWorkflowFile(".github/workflows/pr-target.yml", safeContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.PULL_REQUEST_TARGET_CHECKOUT),
      );
      expect(targetFindings.length).toBe(0);
    });
  });

  describe("Rule 2: Script injection via github.event.* in run: steps", () => {
    const vulnContent = readFixture("rule2-script-injection.vulnerable.yml");
    const safeContent = readFixture("rule2-script-injection.safe.yml");

    it("flags vulnerable inline expression injection with HIGH severity and line number", () => {
      const findings = scanWorkflowFile(".github/workflows/script-inj.yml", vulnContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.SCRIPT_INJECTION),
      );

      expect(targetFindings.length).toBeGreaterThan(0);
      const finding = targetFindings[0];
      expect(finding.severity).toBe("HIGH");
      expect(finding.type).toBe("Vulnerability");
      expect(finding.description).toContain(RULE_IDS.SCRIPT_INJECTION);
      expect(finding.description).toContain("Fix:");
      expect(finding.remediation).toContain("environment variable");
      expect(finding.lineStart).toBe(14);
      expect(finding.codeSnippet).toContain("github.event.issue.title");
    });

    it("flags multi-line block scalar run: script injection", () => {
      const multiline = `name: Multiline
on: [push]
permissions:
  contents: read
jobs:
  run-multi:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "Starting"
          echo "\${{ github.event.head_commit.message }}"
`;
      const findings = scanWorkflowFile(".github/workflows/multi.yml", multiline);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.SCRIPT_INJECTION),
      );
      expect(targetFindings.length).toBe(1);
      expect(targetFindings[0].lineStart).toBe(11);
    });

    it("passes safe workflow using env: for event fields", () => {
      const findings = scanWorkflowFile(".github/workflows/script-inj.yml", safeContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.SCRIPT_INJECTION),
      );
      expect(targetFindings.length).toBe(0);
    });
  });

  describe("Rule 3: Unpinned actions (mutable tags/branches)", () => {
    const vulnContent = readFixture("rule3-unpinned-action.vulnerable.yml");
    const safeContent = readFixture("rule3-unpinned-action.safe.yml");

    it("flags unpinned actions with MEDIUM severity", () => {
      const findings = scanWorkflowFile(".github/workflows/unpinned.yml", vulnContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.UNPINNED_ACTION),
      );

      expect(targetFindings.length).toBe(2);
      expect(targetFindings[0].severity).toBe("MEDIUM");
      expect(targetFindings[0].type).toBe("Misconfig");
      expect(targetFindings[0].description).toContain(RULE_IDS.UNPINNED_ACTION);
      expect(targetFindings[0].remediation).toContain("full 40-character commit SHA");
      expect(targetFindings[0].codeSnippet).toContain("actions/checkout@v4");
      expect(targetFindings[1].codeSnippet).toContain("actions/setup-node@main");
    });

    it("passes actions pinned to full 40-character commit SHA or local actions", () => {
      const findings = scanWorkflowFile(".github/workflows/pinned.yml", safeContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.UNPINNED_ACTION),
      );
      expect(targetFindings.length).toBe(0);
    });
  });

  describe("Rule 4: Permissions write-all or missing permissions", () => {
    const writeAllContent = readFixture("rule4-permissions-write-all.vulnerable.yml");
    const missingContent = readFixture("rule4-permissions-missing.vulnerable.yml");
    const safeContent = readFixture("rule4-permissions.safe.yml");

    it("flags permissions: write-all with HIGH severity", () => {
      const findings = scanWorkflowFile(".github/workflows/write-all.yml", writeAllContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.PERMISSIONS_BROAD_OR_MISSING),
      );

      expect(targetFindings.length).toBeGreaterThan(0);
      expect(targetFindings[0].severity).toBe("HIGH");
      expect(targetFindings[0].type).toBe("Misconfig");
      expect(targetFindings[0].codeSnippet).toContain("permissions: write-all");
      expect(targetFindings[0].remediation).toContain("minimal required permissions");
    });

    it("flags missing permissions block with MEDIUM severity at line 1", () => {
      const findings = scanWorkflowFile(".github/workflows/missing-perm.yml", missingContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.PERMISSIONS_BROAD_OR_MISSING),
      );

      expect(targetFindings.length).toBe(1);
      expect(targetFindings[0].severity).toBe("MEDIUM");
      expect(targetFindings[0].lineStart).toBe(1);
      expect(targetFindings[0].remediation).toContain("top-level permissions: block");
    });

    it("passes workflow with explicit least-privilege permissions", () => {
      const findings = scanWorkflowFile(".github/workflows/safe-perm.yml", safeContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.PERMISSIONS_BROAD_OR_MISSING),
      );
      expect(targetFindings.length).toBe(0);
    });
  });

  describe("Rule 5: Secrets inherit on third-party reusable workflows", () => {
    const vulnContent = readFixture("rule5-secrets-inherit.vulnerable.yml");
    const safeContent = readFixture("rule5-secrets-inherit.safe.yml");

    it("flags secrets: inherit on external reusable workflow with HIGH severity", () => {
      const findings = scanWorkflowFile(".github/workflows/secrets-inherit.yml", vulnContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.SECRETS_INHERIT_THIRD_PARTY),
      );

      expect(targetFindings.length).toBe(1);
      expect(targetFindings[0].severity).toBe("HIGH");
      expect(targetFindings[0].type).toBe("Misconfig");
      expect(targetFindings[0].codeSnippet).toBe("secrets: inherit");
      expect(targetFindings[0].description).toContain("third-party reusable workflow");
      expect(targetFindings[0].remediation).toContain("Explicitly pass only");
    });

    it("passes local reusable workflow with secrets inherit and third-party with explicit secrets", () => {
      const findings = scanWorkflowFile(".github/workflows/safe-secrets.yml", safeContent);
      const targetFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.SECRETS_INHERIT_THIRD_PARTY),
      );
      expect(targetFindings.length).toBe(0);
    });
  });

  describe("runWorkflowSecurityRules across file changes", () => {
    it("ignores files outside .github/workflows/", () => {
      const files = [
        {
          filename: "src/lib/armor/scanner.ts",
          patch: "+ permissions: write-all\n+ uses: actions/checkout@v4",
        },
        {
          filename: "workflows/ci.yml",
          patch: "+ permissions: write-all",
        },
      ];

      const findings = runWorkflowSecurityRules(files);
      expect(findings.length).toBe(0);
    });

    it("scans changed files under .github/workflows/ and parses diff hunks", () => {
      const diffPatch = `--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,3 +10,4 @@
 permissions:
   contents: read
+      - uses: actions/checkout@v4
`;
      const files = [
        {
          filename: ".github/workflows/ci.yml",
          patch: diffPatch,
        },
      ];

      const findings = runWorkflowSecurityRules(files);
      const unpinned = findings.filter((f) =>
        f.matchedSignatures?.includes(RULE_IDS.UNPINNED_ACTION),
      );
      expect(unpinned.length).toBe(1);
      expect(unpinned[0].lineStart).toBe(12);
    });
  });
});
