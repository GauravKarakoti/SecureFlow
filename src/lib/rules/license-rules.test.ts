import { describe, it, expect } from "vitest";
import {
  scanFileWithLicenseRules,
  runLicenseSecurityRules,
  evaluateLicenseCompliance,
  resolveDependencyLicense,
  normalizeSpdx,
  matchesLicenseList,
  LICENSE_RULE_IDS,
} from "./license-rules";
import type { FileChange } from "@/lib/armor/scanner";

describe("License Compliance Rules (#2093)", () => {
  describe("SPDX Utilities", () => {
    it("normalizes license identifiers", () => {
      expect(normalizeSpdx("MIT")).toBe("MIT");
      expect(normalizeSpdx("  Apache-2.0  ")).toBe("Apache-2.0");
      expect(normalizeSpdx("unknown")).toBe("unknown");
      expect(normalizeSpdx("")).toBe("unknown");
    });

    it("matches license against list case-insensitively and with variant handling", () => {
      const list = ["mit", "Apache-2.0", "GPL-3.0"];
      expect(matchesLicenseList("MIT", list)).toBe(true);
      expect(matchesLicenseList("mit", list)).toBe(true);
      expect(matchesLicenseList("Apache-2.0", list)).toBe(true);
      expect(matchesLicenseList("GPL-3.0-only", list)).toBe(true);
      expect(matchesLicenseList("GPL-3.0-or-later", list)).toBe(true);
      expect(matchesLicenseList("BSD-3-Clause", list)).toBe(false);
    });
  });

  describe("License Evaluation Logic", () => {
    it("reports unknown when license is unknown and does not treat it as denied", () => {
      const result = evaluateLicenseCompliance("some-pkg", "unknown", {
        denyList: ["AGPL-3.0-only", "GPL-3.0-only"],
        allowList: ["MIT", "Apache-2.0"],
      });
      expect(result.status).toBe("unknown");
      expect(result.status).not.toBe("denied");
      expect(result.status).not.toBe("allowed");
    });

    it("flags denied license when matching denyList", () => {
      const result = evaluateLicenseCompliance("copyleft-lib", "AGPL-3.0-only", {
        denyList: ["AGPL-3.0-only", "GPL-3.0"],
      });
      expect(result.status).toBe("denied");
      expect(result.reason).toContain("AGPL-3.0-only");
    });

    it("allows license not in denyList when no allowList is configured", () => {
      const result = evaluateLicenseCompliance("good-lib", "MIT", {
        denyList: ["AGPL-3.0-only"],
      });
      expect(result.status).toBe("allowed");
    });

    it("flags denied license when allowList is configured and license is not in allowList", () => {
      const result = evaluateLicenseCompliance("gpl-lib", "GPL-3.0-only", {
        allowList: ["MIT", "Apache-2.0", "BSD-3-Clause"],
      });
      expect(result.status).toBe("denied");
      expect(result.reason).toContain("allowList");
    });

    it("allows license present in allowList", () => {
      const result = evaluateLicenseCompliance("react", "MIT", {
        allowList: ["MIT", "Apache-2.0"],
      });
      expect(result.status).toBe("allowed");
    });

    it("denyList takes priority when license matches denyList even if in allowList", () => {
      const result = evaluateLicenseCompliance("conflict-pkg", "GPL-3.0-only", {
        allowList: ["GPL-3.0-only", "MIT"],
        denyList: ["GPL-3.0-only"],
      });
      expect(result.status).toBe("denied");
    });
  });

  describe("License Resolution", () => {
    it("uses embedded lockfile license if present", () => {
      const license = resolveDependencyLicense({
        name: "custom-internal-lib",
        license: "Apache-2.0",
        lineNumber: 10,
        lineSnippet: "",
      });
      expect(license).toBe("Apache-2.0");
    });

    it("resolves popular npm and python packages offline from built-in dictionary", () => {
      expect(resolveDependencyLicense({ name: "react", lineNumber: 1, lineSnippet: "" })).toBe(
        "MIT",
      );
      expect(resolveDependencyLicense({ name: "express", lineNumber: 1, lineSnippet: "" })).toBe(
        "MIT",
      );
      expect(resolveDependencyLicense({ name: "requests", lineNumber: 1, lineSnippet: "" })).toBe(
        "Apache-2.0",
      );
      expect(resolveDependencyLicense({ name: "django", lineNumber: 1, lineSnippet: "" })).toBe(
        "BSD-3-Clause",
      );
    });

    it("supports packageLicenseOverrides", () => {
      const license = resolveDependencyLicense(
        { name: "my-proprietary-dep", lineNumber: 1, lineSnippet: "" },
        { packageLicenseOverrides: { "my-proprietary-dep": "UNLICENSED" } },
      );
      expect(license).toBe("UNLICENSED");
    });

    it("returns 'unknown' when metadata is missing", () => {
      const license = resolveDependencyLicense({
        name: "completely-unknown-package-xyz",
        lineNumber: 1,
        lineSnippet: "",
      });
      expect(license).toBe("unknown");
    });
  });

  describe("package.json Scanning", () => {
    it("reports denied license when added in dependencies diff with denyList", () => {
      const patch = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
     "react": "^18.0.0",
+    "agpl-test-pkg": "^1.0.0"
   }
`;
      const findings = scanFileWithLicenseRules("package.json", patch, {
        denyList: ["AGPL-3.0-only"],
      });

      expect(findings.length).toBe(1);
      expect(findings[0].matchedSignatures).toContain(LICENSE_RULE_IDS.DENIED_LICENSE);
      expect(findings[0].description).toContain("agpl-test-pkg");
      expect(findings[0].description).toContain("AGPL-3.0-only");
      expect(findings[0].severity).toBe("HIGH");
      expect(findings[0].type).toBe("License Compliance");
    });

    it("reports unknown license as 'unknown' and not as denied", () => {
      const patch = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
+    "unknown-pkg-12345": "^1.0.0"
   }
`;
      const findings = scanFileWithLicenseRules("package.json", patch, {
        denyList: ["AGPL-3.0-only"],
        allowList: ["MIT", "Apache-2.0"],
      });

      expect(findings.length).toBe(1);
      expect(findings[0].matchedSignatures).toContain(LICENSE_RULE_IDS.UNKNOWN_LICENSE);
      expect(findings[0].matchedSignatures).not.toContain(LICENSE_RULE_IDS.DENIED_LICENSE);
      expect(findings[0].description).toContain("unknown license");
      expect(findings[0].severity).toBe("LOW");
    });

    it("allows dependencies matching allowList", () => {
      const patch = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
+    "react": "^18.2.0"
   }
`;
      const findings = scanFileWithLicenseRules("package.json", patch, {
        allowList: ["MIT"],
      });

      expect(findings.length).toBe(0);
    });

    it("flags dependencies failing allowList", () => {
      const patch = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
+    "typescript": "^5.0.0"
   }
`;
      // typescript is Apache-2.0
      const findings = scanFileWithLicenseRules("package.json", patch, {
        allowList: ["MIT"], // only MIT allowed
      });

      expect(findings.length).toBe(1);
      expect(findings[0].matchedSignatures).toContain(LICENSE_RULE_IDS.DENIED_LICENSE);
      expect(findings[0].description).toContain("typescript");
      expect(findings[0].description).toContain("Apache-2.0");
    });
  });

  describe("Lockfile Scanning (package-lock.json with embedded license)", () => {
    it("extracts embedded license from package-lock.json and flags denied license", () => {
      const patch = `
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -50,6 +50,12 @@
+    "node_modules/custom-agpl-tool": {
+      "version": "2.1.0",
+      "license": "AGPL-3.0",
+      "resolved": "https://registry.npmjs.org/custom-agpl-tool/-/custom-agpl-tool-2.1.0.tgz"
+    },
     "node_modules/lodash": {
`;
      const findings = scanFileWithLicenseRules("package-lock.json", patch, {
        denyList: ["AGPL-3.0"],
      });

      expect(findings.length).toBe(1);
      expect(findings[0].matchedSignatures).toContain(LICENSE_RULE_IDS.DENIED_LICENSE);
      expect(findings[0].description).toContain("custom-agpl-tool");
      expect(findings[0].description).toContain("AGPL-3.0");
    });

    it("does not flag approved licenses from package-lock.json", () => {
      const patch = `
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -50,6 +50,12 @@
+    "node_modules/custom-mit-tool": {
+      "version": "1.0.0",
+      "license": "MIT",
+      "resolved": "https://registry.npmjs.org/custom-mit-tool/-/custom-mit-tool-1.0.0.tgz"
+    },
     "node_modules/lodash": {
`;
      const findings = scanFileWithLicenseRules("package-lock.json", patch, {
        allowList: ["MIT"],
      });

      expect(findings.length).toBe(0);
    });
  });

  describe("Python requirements.txt Scanning", () => {
    it("detects Python dependencies with denied license", () => {
      const patch = `
diff --git a/requirements.txt b/requirements.txt
--- a/requirements.txt
+++ b/requirements.txt
@@ -1,2 +1,3 @@
 requests==2.31.0
+plone==5.2.0
`;
      // plone is GPL-2.0-only in known licenses
      const findings = scanFileWithLicenseRules("requirements.txt", patch, {
        denyList: ["GPL-2.0-only"],
      });

      expect(findings.length).toBe(1);
      expect(findings[0].matchedSignatures).toContain(LICENSE_RULE_IDS.DENIED_LICENSE);
      expect(findings[0].description).toContain("plone");
      expect(findings[0].description).toContain("GPL-2.0-only");
    });

    it("identifies unknown Python dependencies without denying them", () => {
      const patch = `
diff --git a/requirements.txt b/requirements.txt
--- a/requirements.txt
+++ b/requirements.txt
@@ -1,2 +1,3 @@
+some-rare-py-dep==0.0.1
`;
      const findings = scanFileWithLicenseRules("requirements.txt", patch, {
        denyList: ["GPL-3.0-only"],
      });

      expect(findings.length).toBe(1);
      expect(findings[0].matchedSignatures).toContain(LICENSE_RULE_IDS.UNKNOWN_LICENSE);
      expect(findings[0].description).toContain("some-rare-py-dep");
      expect(findings[0].description).toContain("unknown license");
    });

    it("allows configured packageLicenseOverrides for Python dependencies", () => {
      const patch = `
diff --git a/requirements.txt b/requirements.txt
--- a/requirements.txt
+++ b/requirements.txt
@@ -1,2 +1,3 @@
+internal-py-lib==1.0.0
`;
      const findings = scanFileWithLicenseRules("requirements.txt", patch, {
        allowList: ["Apache-2.0"],
        packageLicenseOverrides: {
          "internal-py-lib": "Apache-2.0",
        },
      });

      expect(findings.length).toBe(0);
    });
  });

  describe("Configuration and Disabling Rules", () => {
    it("can disable unknown license reporting", () => {
      const patch = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
+    "unrecognized-dep-xyz": "^1.0.0"
   }
`;
      const findings = scanFileWithLicenseRules("package.json", patch, {
        reportUnknown: false,
      });

      expect(findings.length).toBe(0);
    });

    it("can disable specific rule ID via disabledRules", () => {
      const patch = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,3 +10,4 @@
   "dependencies": {
+    "agpl-test-pkg": "^1.0.0"
   }
`;
      const findings = scanFileWithLicenseRules("package.json", patch, {
        denyList: ["AGPL-3.0-only"],
        disabledRules: [LICENSE_RULE_IDS.DENIED_LICENSE],
      });

      expect(findings.length).toBe(0);
    });

    it("returns empty findings when enabled is false", () => {
      const files: FileChange[] = [
        {
          filename: "package.json",
          patch: `+    "agpl-test-pkg": "^1.0.0"`,
        },
      ];
      const findings = runLicenseSecurityRules(files, {
        enabled: false,
        denyList: ["AGPL-3.0-only"],
      });
      expect(findings.length).toBe(0);
    });
  });
});
