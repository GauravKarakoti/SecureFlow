import { describe, it, expect } from "vitest";
import {
  scanFileWithUnicodeRules,
  runUnicodeSecurityRules,
  isLegitimatelyNonLatinFile,
  UNICODE_RULE_IDS,
  BIDI_CODEPOINTS,
  ZERO_WIDTH_CODEPOINTS,
  HOMOGLYPH_MAP,
} from "./unicode-rules";
import { parseSecureFlowConfig, resolveUnicodeRuleOptions } from "@/lib/scanner/gate-config";

describe("Unicode Trojan Source and Homoglyph Security Rules (#2089)", () => {
  describe("Bidirectional control characters (SEC_UNICODE_BIDI_CONTROL)", () => {
    it("flags RLO (U+202E) in added code with HIGH severity and names the code point", () => {
      // Classic Trojan source pattern using RLO \u202E
      const patch = [
        "@@ -1,3 +1,4 @@",
        " function checkAccess(user) {",
        '+  /* \u202E } \u2066if (user.isAdmin) \u2069 \u2066 */ return true;',
        "   return false;",
        " }",
      ].join("\n");

      const findings = scanFileWithUnicodeRules("src/auth.js", patch);
      expect(findings.length).toBeGreaterThanOrEqual(1);

      const bidiFinding = findings.find(
        (f) => f.matchedSignatures?.[0] === UNICODE_RULE_IDS.BIDI_CONTROL,
      );
      expect(bidiFinding).toBeDefined();
      expect(bidiFinding?.severity).toBe("HIGH");
      expect(bidiFinding?.lineStart).toBe(2);
      expect(bidiFinding?.description).toContain("U+202E");
      expect(bidiFinding?.description).toContain("U+2066");
      expect(bidiFinding?.description).toContain("U+2069");
      expect(bidiFinding?.fileLocation).toBe("src/auth.js");
      expect(bidiFinding?.fingerprint).toBeDefined();
      expect(bidiFinding?.dynamicFingerprint).toBeDefined();
    });

    it("does not flag bidi characters in removed or unchanged lines", () => {
      const patch = [
        "@@ -1,4 +1,3 @@",
        '-  /* \u202E } if (user.isAdmin) */ return true;',
        "   /* unchanged context line \u202E */",
        "+  return false;",
      ].join("\n");

      const findings = scanFileWithUnicodeRules("src/auth.js", patch);
      expect(findings.length).toBe(0);
    });
  });

  describe("Zero-width characters (SEC_UNICODE_ZERO_WIDTH)", () => {
    it("flags zero-width space (U+200B) in added lines with HIGH severity and names the code point", () => {
      const patch = [
        "@@ -1,2 +1,3 @@",
        " const secret = 'key';",
        '+ const admin\u200BUser = "attacker";',
        " console.log(secret);",
      ].join("\n");

      const findings = scanFileWithUnicodeRules("src/user.ts", patch);
      const zwFinding = findings.find(
        (f) => f.matchedSignatures?.[0] === UNICODE_RULE_IDS.ZERO_WIDTH,
      );
      expect(zwFinding).toBeDefined();
      expect(zwFinding?.severity).toBe("HIGH");
      expect(zwFinding?.lineStart).toBe(2);
      expect(zwFinding?.description).toContain("U+200B");
      expect(zwFinding?.description).toContain("Zero-Width Space");
    });

    it("flags zero-width joiner (U+200D) and byte-order mark (U+FEFF)", () => {
      const patch = [
        "@@ -1,2 +1,3 @@",
        " function run() {",
        '+   const token\u200D = "\uFEFFsecret";',
        " }",
      ].join("\n");

      const findings = scanFileWithUnicodeRules("src/app.py", patch);
      const zwFinding = findings.find(
        (f) => f.matchedSignatures?.[0] === UNICODE_RULE_IDS.ZERO_WIDTH,
      );
      expect(zwFinding).toBeDefined();
      expect(zwFinding?.description).toContain("U+200D");
      expect(zwFinding?.description).toContain("U+FEFF");
    });
  });

  describe("Look-alike / Homoglyph identifiers (SEC_UNICODE_HOMOGLYPH_IDENTIFIER)", () => {
    it("flags Cyrillic homoglyph in an otherwise Latin identifier", () => {
      // 'а' is Cyrillic \u0430, 'admin' with Cyrillic 'а' -> '\u0430dmin'
      const patch = [
        "@@ -1,2 +1,3 @@",
        " const config = {};",
        '+ const \u0430dmin = true;',
        " if (admin) { access(); }",
      ].join("\n");

      const findings = scanFileWithUnicodeRules("src/permissions.js", patch);
      const homoglyphFinding = findings.find(
        (f) => f.matchedSignatures?.[0] === UNICODE_RULE_IDS.HOMOGLYPH_IDENTIFIER,
      );
      expect(homoglyphFinding).toBeDefined();
      expect(homoglyphFinding?.severity).toBe("HIGH");
      expect(homoglyphFinding?.description).toContain("U+0430");
      expect(homoglyphFinding?.description).toContain("Cyrillic");
      expect(homoglyphFinding?.description).toContain("a");
    });

    it("flags Greek homoglyph in Latin identifier", () => {
      // Greek small letter alpha \u03B1 in 'auth' -> '\u03B1uth'
      const patch = [
        "@@ -1,1 +1,2 @@",
        '+ const \u03B1uth = "spoofed";',
      ].join("\n");

      const findings = scanFileWithUnicodeRules("src/index.ts", patch);
      const homoglyphFinding = findings.find(
        (f) => f.matchedSignatures?.[0] === UNICODE_RULE_IDS.HOMOGLYPH_IDENTIFIER,
      );
      expect(homoglyphFinding).toBeDefined();
      expect(homoglyphFinding?.description).toContain("U+03B1");
      expect(homoglyphFinding?.description).toContain("Greek");
    });
  });

  describe("Non-Latin file exemption (allow rules)", () => {
    it("identifies documentation and localization paths as legitimately non-Latin", () => {
      expect(isLegitimatelyNonLatinFile("docs/guide.md")).toBe(true);
      expect(isLegitimatelyNonLatinFile("documentation/fr/readme.txt")).toBe(true);
      expect(isLegitimatelyNonLatinFile("locales/ja/messages.json")).toBe(true);
      expect(isLegitimatelyNonLatinFile("i18n/ru/strings.po")).toBe(true);
      expect(isLegitimatelyNonLatinFile("translations/de.yml")).toBe(true);
      expect(isLegitimatelyNonLatinFile("src/components/Button.tsx")).toBe(false);
    });

    it("does not flag non-Latin text / homoglyphs in allowed documentation files", () => {
      const patch = [
        "@@ -1,1 +1,3 @@",
        '+ # Documentation en français et russe',
        '+ Ceci est une explication pour \u0430dmin et utilisateurs.',
      ].join("\n");

      const findings = scanFileWithUnicodeRules("docs/overview.md", patch);
      expect(findings.length).toBe(0);
    });

    it("does not flag non-Latin strings in localization files", () => {
      const patch = [
        "@@ -1,1 +1,4 @@",
        '+ {',
        '+   "greeting": "Привет мир \u03B1",',
        '+ }',
      ].join("\n");

      const findings = scanFileWithUnicodeRules("locales/ru/strings.json", patch);
      expect(findings.length).toBe(0);
    });

    it("supports custom allow patterns passed in options", () => {
      const patch = [
        "@@ -1,1 +1,2 @@",
        '+ const \u0430dmin = "custom";',
      ].join("\n");

      // Without custom pattern: flagged
      const findingsNormal = scanFileWithUnicodeRules("src/custom/test.js", patch);
      expect(findingsNormal.length).toBeGreaterThan(0);

      // With custom allow pattern matching file: skipped
      const findingsAllowed = scanFileWithUnicodeRules("src/custom/test.js", patch, {
        allowPatterns: ["src/custom/**"],
      });
      expect(findingsAllowed.length).toBe(0);
    });

    it("still flags bidi controls even in documentation files because bidi override is malicious anywhere", () => {
      const patch = [
        "@@ -1,1 +1,2 @@",
        '+ # Document with hidden override \u202E Trojan text \u206C',
      ].join("\n");

      const findings = scanFileWithUnicodeRules("docs/readme.md", patch);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].matchedSignatures?.[0]).toBe(UNICODE_RULE_IDS.BIDI_CONTROL);
    });
  });

  describe("Rule configuration and disabling via .secureflow.json", () => {
    it("parses unicode configuration from .secureflow.json", () => {
      const json = JSON.stringify({
        gate: { blockOn: "HIGH" },
        unicode: {
          enabled: true,
          disabledRules: ["SEC_UNICODE_HOMOGLYPH_IDENTIFIER"],
          allowPatterns: ["legit-unicode/**"],
        },
      });

      const config = parseSecureFlowConfig(json);
      const options = resolveUnicodeRuleOptions(config);

      expect(options.enabled).toBe(true);
      expect(options.disabledRules).toContain("SEC_UNICODE_HOMOGLYPH_IDENTIFIER");
      expect(options.allowPatterns).toContain("legit-unicode/**");
    });

    it("respects disabledRules when running rules", () => {
      const patch = [
        "@@ -1,1 +1,2 @@",
        '+ const \u0430dmin = true;',
      ].join("\n");

      const findings = runUnicodeSecurityRules(
        [{ filename: "src/admin.ts", patch }],
        {
          disabledRules: ["SEC_UNICODE_HOMOGLYPH_IDENTIFIER"],
        },
      );
      expect(findings.length).toBe(0);
    });

    it("can disable all unicode rules via enabled: false", () => {
      const patch = [
        "@@ -1,1 +1,2 @@",
        '+ const x = \u202E 1;',
      ].join("\n");

      const findings = runUnicodeSecurityRules(
        [{ filename: "src/main.ts", patch }],
        {
          enabled: false,
        },
      );
      expect(findings.length).toBe(0);
    });
  });

  describe("Repository level runner (runUnicodeSecurityRules)", () => {
    it("scans multiple files and gathers all findings", () => {
      const files = [
        {
          filename: "src/one.js",
          patch: "@@ -1,1 +1,2 @@\n+ const val = 'hello\u200B';",
        },
        {
          filename: "src/two.py",
          patch: "@@ -1,1 +1,2 @@\n+ # \u202E RLO check \u206C",
        },
      ];

      const findings = runUnicodeSecurityRules(files, { repositoryId: "repo-123" });
      expect(findings.length).toBe(2);
      expect(findings[0].fileLocation).toBe("src/one.js");
      expect(findings[1].fileLocation).toBe("src/two.py");
    });
  });
});
