import { describe, it, expect } from "vitest";
import {
  scanFileWithObfuscationRules,
  runObfuscationSecurityRules,
  checkLineForObfuscation,
  OBFUSCATION_RULE_IDS,
  MIN_BLOB_LENGTH,
} from "./obfuscation-rules";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePatch(addedLine: string): string {
  return `@@ -1,1 +1,2 @@\n context line\n+${addedLine}`;
}

function makeRemovedPatch(line: string): string {
  return `@@ -1,2 +1,1 @@\n context line\n-${line}`;
}

/** Generates a base64-like string of the given length. */
function base64Blob(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = "";
  while (s.length < len) {
    s += chars[s.length % chars.length];
  }
  // Pad to multiple-of-4
  const rem = s.length % 4;
  if (rem) s += "=".repeat(4 - rem);
  return s;
}

/** Generates a hex string of the given length. */
function hexBlob(len: number): string {
  return "deadbeef".repeat(Math.ceil(len / 8)).slice(0, len);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Obfuscation Detection Rules (#2090)", () => {
  describe("SEC_OBFUSC_DECODE_EXECUTE – decode-and-execute patterns", () => {
    it("flags eval(atob(...)) in JS", () => {
      const findings = scanFileWithObfuscationRules("src/app.js", makePatch("eval(atob('aGVsbG8='))"));
      expect(findings).toHaveLength(1);
      expect(findings[0].matchedSignatures?.[0]).toBe(OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE);
      expect(findings[0].severity).toBe("HIGH");
      expect(findings[0].description).toContain("SEC_OBFUSC_DECODE_EXECUTE");
    });

    it("flags new Function(atob(...))", () => {
      const findings = scanFileWithObfuscationRules("src/loader.js", makePatch("const f = new Function(atob(payload));"));
      expect(findings.some((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE)).toBe(true);
    });

    it("flags exec(base64.b64decode(...)) in Python", () => {
      const findings = scanFileWithObfuscationRules("setup.py", makePatch("exec(base64.b64decode(blob))"));
      expect(findings.some((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE)).toBe(true);
    });

    it("flags eval(base64_decode(...)) in PHP", () => {
      const findings = scanFileWithObfuscationRules("index.php", makePatch("eval(base64_decode($code));"));
      expect(findings.some((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE)).toBe(true);
    });

    it("does NOT flag normal eval of a string literal", () => {
      const findings = scanFileWithObfuscationRules("src/test.js", makePatch('eval("1+1")'));
      const decodeExec = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE);
      expect(decodeExec).toHaveLength(0);
    });

    it("does NOT flag decode-and-execute on removed lines", () => {
      const findings = scanFileWithObfuscationRules("src/app.js", makeRemovedPatch("eval(atob('aGVsbG8='))"));
      expect(findings).toHaveLength(0);
    });
  });

  describe("SEC_OBFUSC_LONG_BASE64_BLOB – boundary tests", () => {
    it(`does NOT flag base64 blob shorter than MIN_BLOB_LENGTH (${MIN_BLOB_LENGTH})`, () => {
      const short = base64Blob(MIN_BLOB_LENGTH - 4);
      const findings = scanFileWithObfuscationRules("src/data.js", makePatch(`const x = "${short}";`));
      const blobFindings = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.LONG_BASE64_BLOB);
      expect(blobFindings).toHaveLength(0);
    });

    it(`flags base64 blob exactly at MIN_BLOB_LENGTH (${MIN_BLOB_LENGTH})`, () => {
      // base64Blob ensures multiple-of-4 length ≥ MIN_BLOB_LENGTH
      const blob = base64Blob(MIN_BLOB_LENGTH);
      const findings = scanFileWithObfuscationRules("src/data.js", makePatch(`const x = "${blob}";`));
      const blobFindings = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.LONG_BASE64_BLOB);
      expect(blobFindings.length).toBeGreaterThanOrEqual(1);
      expect(blobFindings[0].severity).toBe("MEDIUM");
    });

    it("does NOT flag short data URI (image) even if it has base64", () => {
      const shortDataUri = `data:image/png;base64,${base64Blob(100)}`;
      const findings = scanFileWithObfuscationRules("src/app.js", makePatch(`const img = "${shortDataUri}";`));
      const blobFindings = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.LONG_BASE64_BLOB);
      expect(blobFindings).toHaveLength(0);
    });
  });

  describe("SEC_OBFUSC_LONG_HEX_BLOB – boundary tests", () => {
    it("does NOT flag a short hex string", () => {
      const findings = scanFileWithObfuscationRules("src/constants.js", makePatch(`const COLOR = "deadbeef";`));
      const hexFindings = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.LONG_HEX_BLOB);
      expect(hexFindings).toHaveLength(0);
    });

    it(`flags hex blob at exactly MIN_BLOB_LENGTH (${MIN_BLOB_LENGTH})`, () => {
      const blob = hexBlob(MIN_BLOB_LENGTH);
      const findings = scanFileWithObfuscationRules("src/shellcode.c", makePatch(`char code[] = "${blob}";`));
      const hexFindings = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.LONG_HEX_BLOB);
      expect(hexFindings.length).toBeGreaterThanOrEqual(1);
      expect(hexFindings[0].severity).toBe("MEDIUM");
    });
  });

  describe("Lockfile exclusion", () => {
    it("does NOT flag decode-and-execute in package-lock.json", () => {
      const findings = scanFileWithObfuscationRules("package-lock.json", makePatch("eval(atob(payload))"));
      expect(findings).toHaveLength(0);
    });

    it("does NOT flag long base64 blob in yarn.lock", () => {
      const blob = base64Blob(300);
      const findings = scanFileWithObfuscationRules("yarn.lock", makePatch(`resolved "${blob}"`));
      expect(findings).toHaveLength(0);
    });
  });

  describe("disabledRules and enabled flag", () => {
    it("respects disabledRules: suppresses a specific rule", () => {
      const findings = scanFileWithObfuscationRules(
        "src/app.js",
        makePatch("eval(atob(payload))"),
        { disabledRules: ["SEC_OBFUSC_DECODE_EXECUTE"] },
      );
      const decodeExec = findings.filter((f) => f.matchedSignatures?.[0] === OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE);
      expect(decodeExec).toHaveLength(0);
    });

    it("respects enabled: false to suppress all findings", () => {
      const findings = runObfuscationSecurityRules(
        [{ filename: "src/app.js", patch: makePatch("eval(atob(payload))") }],
        { enabled: false },
      );
      expect(findings).toHaveLength(0);
    });
  });

  describe("runObfuscationSecurityRules – multi-file", () => {
    it("scans multiple files and collects all findings", () => {
      const files = [
        { filename: "src/a.js", patch: makePatch("eval(atob(x))") },
        { filename: "src/b.py", patch: makePatch("exec(base64.b64decode(blob))") },
      ];
      const findings = runObfuscationSecurityRules(files, { repositoryId: "repo-1" });
      expect(findings.length).toBeGreaterThanOrEqual(2);
    });
  });
});
