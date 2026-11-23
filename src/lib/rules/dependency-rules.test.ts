import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  isDependencyManifest,
  detectTyposquat,
  isGitOrTarballSpecifier,
  scanDependencyManifest,
  runDependencySecurityRules,
  DEPENDENCY_RULE_IDS,
  POPULAR_NPM_PACKAGES,
  POPULAR_PYPI_PACKAGES,
  damerauLevenshteinDistance,
} from "./dependency-rules";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

describe("Deterministic Dependency Security Rules (#2003)", () => {
  describe("isDependencyManifest", () => {
    it("recognizes npm and Python manifest and lockfile paths", () => {
      expect(isDependencyManifest("package.json")).toBe(true);
      expect(isDependencyManifest("app/package.json")).toBe(true);
      expect(isDependencyManifest("package-lock.json")).toBe(true);
      expect(isDependencyManifest("yarn.lock")).toBe(true);
      expect(isDependencyManifest("pnpm-lock.yaml")).toBe(true);
      expect(isDependencyManifest("requirements.txt")).toBe(true);
      expect(isDependencyManifest("backend/requirements.txt")).toBe(true);
      expect(isDependencyManifest("requirements-dev.txt")).toBe(true);
      expect(isDependencyManifest("requirements/prod.txt")).toBe(true);
    });

    it("rejects non-manifest files", () => {
      expect(isDependencyManifest("src/index.ts")).toBe(false);
      expect(isDependencyManifest("README.md")).toBe(false);
      expect(isDependencyManifest("docker-compose.yml")).toBe(false);
      expect(isDependencyManifest("")).toBe(false);
    });
  });

  describe("damerauLevenshteinDistance & detectTyposquat", () => {
    it("computes accurate distance including transpositions", () => {
      expect(damerauLevenshteinDistance("lodash", "lodash")).toBe(0);
      expect(damerauLevenshteinDistance("lodashs", "lodash")).toBe(1);
      expect(damerauLevenshteinDistance("recat", "react")).toBe(1); // transposition
      expect(damerauLevenshteinDistance("reqeusts", "requests")).toBe(1); // transposition
    });

    it("does NOT flag legitimate popular packages (distance 0)", () => {
      expect(detectTyposquat("react", POPULAR_NPM_PACKAGES).isTyposquat).toBe(false);
      expect(detectTyposquat("express", POPULAR_NPM_PACKAGES).isTyposquat).toBe(false);
      expect(detectTyposquat("lodash", POPULAR_NPM_PACKAGES).isTyposquat).toBe(false);
      expect(detectTyposquat("cross-env", POPULAR_NPM_PACKAGES).isTyposquat).toBe(false);
      expect(detectTyposquat("requests", POPULAR_PYPI_PACKAGES).isTyposquat).toBe(false);
      expect(detectTyposquat("colorama", POPULAR_PYPI_PACKAGES).isTyposquat).toBe(false);
      expect(detectTyposquat("flask", POPULAR_PYPI_PACKAGES).isTyposquat).toBe(false);
    });

    it("flags known typosquats and returns target popular package", () => {
      const npmCheck1 = detectTyposquat("lodashs", POPULAR_NPM_PACKAGES);
      expect(npmCheck1.isTyposquat).toBe(true);
      expect(npmCheck1.target).toBe("lodash");

      const npmCheck2 = detectTyposquat("cross-envv", POPULAR_NPM_PACKAGES);
      expect(npmCheck2.isTyposquat).toBe(true);
      expect(npmCheck2.target).toBe("cross-env");

      const pypiCheck1 = detectTyposquat("reqeusts", POPULAR_PYPI_PACKAGES);
      expect(pypiCheck1.isTyposquat).toBe(true);
      expect(pypiCheck1.target).toBe("requests");

      const pypiCheck2 = detectTyposquat("coloramaa", POPULAR_PYPI_PACKAGES);
      expect(pypiCheck2.isTyposquat).toBe(true);
      expect(pypiCheck2.target).toBe("colorama");
    });
  });

  describe("isGitOrTarballSpecifier", () => {
    it("flags git protocols and github shortcuts", () => {
      expect(isGitOrTarballSpecifier("git+https://github.com/foo/bar.git")).toBe(true);
      expect(isGitOrTarballSpecifier("git+ssh://git@github.com/foo/bar.git")).toBe(true);
      expect(isGitOrTarballSpecifier("github:foo/bar")).toBe(true);
      expect(isGitOrTarballSpecifier("https://github.com/foo/bar/archive/v1.0.tar.gz")).toBe(true);
    });

    it("flags tarballs and zip archives", () => {
      expect(isGitOrTarballSpecifier("https://evil.com/payload.tgz")).toBe(true);
      expect(isGitOrTarballSpecifier("https://untrusted.com/pkg-1.0.0.tar.gz")).toBe(true);
      expect(isGitOrTarballSpecifier("./vendor/package.tgz")).toBe(true);
      expect(isGitOrTarballSpecifier("https://evil.com/wheel.whl")).toBe(true);
    });

    it("passes normal registry semver ranges", () => {
      expect(isGitOrTarballSpecifier("^4.18.2")).toBe(false);
      expect(isGitOrTarballSpecifier("~1.2.3")).toBe(false);
      expect(isGitOrTarballSpecifier(">=2.0.0 <3.0.0")).toBe(false);
      expect(isGitOrTarballSpecifier("1.0.0")).toBe(false);
    });
  });

  describe("npm package.json manifest scanning", () => {
    it("flags typosquat packages and verifies legitimate package is NOT flagged", () => {
      const vulnJson = readFixture("package-typosquat.vulnerable.json");
      const safeJson = readFixture("package-legitimate.safe.json");

      const vulnFindings = scanDependencyManifest("package.json", vulnJson);
      const typosquatFindings = vulnFindings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.TYPOSQUAT),
      );

      expect(typosquatFindings.length).toBe(2);
      expect(typosquatFindings[0].description).toContain("lodashs");
      expect(typosquatFindings[0].description).toContain("lodash");
      expect(typosquatFindings[0].lineStart).toBe(6);
      expect(typosquatFindings[1].description).toContain("cross-envv");
      expect(typosquatFindings[1].lineStart).toBe(7);

      // Legitimate package.json
      const safeFindings = scanDependencyManifest("package.json", safeJson);
      const safeTyposquats = safeFindings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.TYPOSQUAT),
      );
      expect(safeTyposquats.length).toBe(0);
    });

    it("flags git and tarball dependencies in package.json", () => {
      const vulnGitJson = readFixture("package-git-tarball.vulnerable.json");
      const findings = scanDependencyManifest("package.json", vulnGitJson);

      const gitTarballFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.GIT_OR_TARBALL),
      );
      expect(gitTarballFindings.length).toBe(2);
      expect(gitTarballFindings[0].description).toContain("custom-lib");
      expect(gitTarballFindings[0].lineStart).toBe(5);
      expect(gitTarballFindings[0].codeSnippet).toContain(".tgz");
      expect(gitTarballFindings[1].description).toContain("evil-git");
      expect(gitTarballFindings[1].lineStart).toBe(6);
      expect(gitTarballFindings[1].codeSnippet).toContain("git+https");
    });

    it("flags newly added preinstall and postinstall scripts", () => {
      const vulnScriptsJson = readFixture("package-scripts.vulnerable.json");
      const safeScriptsJson = readFixture("package-scripts.safe.json");

      const vulnFindings = scanDependencyManifest("package.json", vulnScriptsJson);
      const scriptFindings = vulnFindings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.LIFECYCLE_SCRIPT),
      );

      expect(scriptFindings.length).toBe(2);
      expect(scriptFindings[0].description).toContain("preinstall");
      expect(scriptFindings[0].lineStart).toBe(6);
      expect(scriptFindings[1].description).toContain("postinstall");
      expect(scriptFindings[1].lineStart).toBe(7);

      // Safe scripts
      const safeFindings = scanDependencyManifest("package.json", safeScriptsJson);
      const safeScriptFindings = safeFindings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.LIFECYCLE_SCRIPT),
      );
      expect(safeScriptFindings.length).toBe(0);
    });
  });

  describe("Python requirements.txt manifest scanning", () => {
    it("flags typosquat packages and verifies legitimate package is NOT flagged", () => {
      const vulnReqs = readFixture("requirements-typosquat.vulnerable.txt");
      const safeReqs = readFixture("requirements-legitimate.safe.txt");

      const vulnFindings = scanDependencyManifest("requirements.txt", vulnReqs);
      const typosquatFindings = vulnFindings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.TYPOSQUAT),
      );

      expect(typosquatFindings.length).toBe(2);
      expect(typosquatFindings[0].description).toContain("coloramaa");
      expect(typosquatFindings[0].description).toContain("colorama");
      expect(typosquatFindings[0].lineStart).toBe(2);
      expect(typosquatFindings[1].description).toContain("reqeusts");
      expect(typosquatFindings[1].description).toContain("requests");
      expect(typosquatFindings[1].lineStart).toBe(3);

      // Legitimate requirements.txt
      const safeFindings = scanDependencyManifest("requirements.txt", safeReqs);
      const safeTyposquats = safeFindings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.TYPOSQUAT),
      );
      expect(safeTyposquats.length).toBe(0);
    });

    it("flags git and tarball dependencies in requirements.txt", () => {
      const vulnGitReqs = readFixture("requirements-git-tarball.vulnerable.txt");
      const findings = scanDependencyManifest("requirements.txt", vulnGitReqs);

      const gitTarballFindings = findings.filter((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.GIT_OR_TARBALL),
      );
      expect(gitTarballFindings.length).toBe(2);
      expect(gitTarballFindings[0].lineStart).toBe(2);
      expect(gitTarballFindings[0].codeSnippet).toContain("malicious-pkg-1.0.0.tar.gz");
      expect(gitTarballFindings[1].lineStart).toBe(3);
      expect(gitTarballFindings[1].codeSnippet).toContain("git+https");
    });
  });

  describe("npm lockfiles scanning", () => {
    it("flags typosquatted and untrusted tarball dependencies in package-lock.json", () => {
      const lockfileDiff = `--- a/package-lock.json
+++ b/package-lock.json
@@ -20,6 +20,12 @@
     "node_modules/express": {
       "version": "4.18.2"
     },
+    "node_modules/lodashs": {
+      "version": "4.17.21",
+      "resolved": "https://untrusted-host.com/packages/lodashs.tgz"
+    }
`;
      const findings = scanDependencyManifest("package-lock.json", lockfileDiff);
      expect(findings.length).toBeGreaterThan(0);

      const typosquat = findings.find((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.TYPOSQUAT),
      );
      expect(typosquat).toBeDefined();
      expect(typosquat?.description).toContain("lodashs");

      const tarball = findings.find((f) =>
        f.matchedSignatures?.includes(DEPENDENCY_RULE_IDS.GIT_OR_TARBALL),
      );
      expect(tarball).toBeDefined();
      expect(tarball?.codeSnippet).toContain("https://untrusted-host.com");
    });
  });

  describe("runDependencySecurityRules across file changes", () => {
    it("ignores non-manifest files and scans modified manifests", () => {
      const files = [
        {
          filename: "src/app.ts",
          patch: `+const lodashs = require("lodashs");`,
        },
        {
          filename: "package.json",
          patch: `--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
     "express": "^4.18.2",
+    "lodashs": "^4.17.21"
   }
`,
        },
        {
          filename: "requirements.txt",
          patch: `--- a/requirements.txt
+++ b/requirements.txt
@@ -1,2 +1,3 @@
 flask==2.0.1
+git+https://github.com/attacker/evil.git#egg=evil
`,
        },
      ];

      const findings = runDependencySecurityRules(files);
      expect(findings.length).toBe(2);

      const npmFinding = findings.find((f) => f.fileLocation === "package.json");
      expect(npmFinding).toBeDefined();
      expect(npmFinding?.description).toContain("lodashs");
      expect(npmFinding?.lineStart).toBe(12);

      const pyFinding = findings.find((f) => f.fileLocation === "requirements.txt");
      expect(pyFinding).toBeDefined();
      expect(pyFinding?.codeSnippet).toContain("git+https");
    });
  });
});
