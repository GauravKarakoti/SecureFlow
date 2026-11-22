import { describe, it, expect, beforeEach } from "vitest";
import {
  computeFingerprint,
  computeDynamicFingerprint,
  normalizeSnippetForFingerprint,
  dynamicFingerprintEngine,
  PayloadSignature,
} from "./fingerprint";
import { scanner } from "./scanner";

describe("computeFingerprint", () => {
  const base = () => computeFingerprint("repo-1", "src/app.ts", "Secret", 'const k = "abc"');

  it("produces a stable 64-char sha256 hex digest", () => {
    const fp = base();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    expect(base()).toBe(base());
  });

  it("stays stable when only line numbers move (line numbers are not an input)", () => {
    const a = computeFingerprint("repo-1", "src/app.ts", "Secret", 'const k = "abc"');
    const b = computeFingerprint("repo-1", "src/app.ts", "Secret", 'const k = "abc"');
    expect(a).toBe(b);
  });

  it("changes when the repository differs", () => {
    expect(base()).not.toBe(
      computeFingerprint("repo-2", "src/app.ts", "Secret", 'const k = "abc"'),
    );
  });

  it("changes when the file location differs", () => {
    expect(base()).not.toBe(
      computeFingerprint("repo-1", "src/other.ts", "Secret", 'const k = "abc"'),
    );
  });

  it("changes when the finding type differs", () => {
    expect(base()).not.toBe(
      computeFingerprint("repo-1", "src/app.ts", "Vulnerability", 'const k = "abc"'),
    );
  });

  it("changes when the code snippet differs", () => {
    expect(base()).not.toBe(
      computeFingerprint("repo-1", "src/app.ts", "Secret", 'const k = "xyz"'),
    );
  });

  it("treats null and undefined snippets the same as an empty snippet", () => {
    const withNull = computeFingerprint("repo-1", "src/app.ts", "Secret", null);
    const withUndefined = computeFingerprint("repo-1", "src/app.ts", "Secret", undefined);
    const withEmpty = computeFingerprint("repo-1", "src/app.ts", "Secret", "");
    expect(withNull).toBe(withUndefined);
    expect(withNull).toBe(withEmpty);
  });

  it("does not collide across field boundaries", () => {
    const a = computeFingerprint("repo", "1src", "Secret", "x");
    const b = computeFingerprint("repo1", "src", "Secret", "x");
    expect(a).not.toBe(b);
  });

  describe("whitespace and line-drift normalization", () => {
    it("normalizes snippets by collapsing intra-line spaces and standardizing line endings", () => {
      const raw = "\r\n  const  a   =   1;\r\n\r\n\r\n  const   b = 2;  \r\n";
      const normalized = normalizeSnippetForFingerprint(raw);
      expect(normalized).toBe("const a = 1;\n\nconst b = 2;");
      expect(normalizeSnippetForFingerprint(null)).toBe("");
      expect(normalizeSnippetForFingerprint(undefined)).toBe("");
    });

    it("produces identical fingerprints for CRLF and LF line endings", () => {
      const lfSnippet = 'const token = "ghp_secret";\nconst user = "admin";';
      const crlfSnippet = 'const token = "ghp_secret";\r\nconst user = "admin";';

      const fpLf = computeFingerprint("repo-1", "src/auth.ts", "Secret", lfSnippet);
      const fpCrlf = computeFingerprint("repo-1", "src/auth.ts", "Secret", crlfSnippet);

      expect(fpLf).toBe(fpCrlf);
    });

    it("survives indentation and Prettier formatting re-alignments", () => {
      const unformatted = 'function leak() {\nconst token = "ghp_secret";\n}';
      const formatted = '  function leak() {\n    const token = "ghp_secret";\n  }';

      const fp1 = computeFingerprint("repo-1", "src/auth.ts", "Secret", unformatted);
      const fp2 = computeFingerprint("repo-1", "src/auth.ts", "Secret", formatted);

      expect(fp1).toBe(fp2);
    });

    it("survives multiple blank lines and intra-line tab/space variations", () => {
      const code1 = 'const key\t=\t"AKIA123";\n\n\nconsole.log(key);';
      const code2 = 'const key = "AKIA123";\n\nconsole.log(key);';

      const fp1 = computeFingerprint("repo-1", "src/aws.ts", "Secret", code1);
      const fp2 = computeFingerprint("repo-1", "src/aws.ts", "Secret", code2);

      expect(fp1).toBe(fp2);
    });
  });
});

describe("Dynamic Security Payload Fingerprinting", () => {
  beforeEach(() => {
    dynamicFingerprintEngine.resetToDefaults();
  });

  it("evaluates built-in zero-day payload signatures", () => {
    const payload = "eval(String.fromCharCode(97, 98, 99))";
    const res = computeDynamicFingerprint("repo-1", "src/eval.ts", "RCE", payload);

    expect(res.isZeroDayDetected).toBe(true);
    expect(res.matchedSignatures.length).toBeGreaterThan(0);
    expect(res.matchedSignatures[0].id).toBe("SIG-ZDAY-001");
    expect(res.riskScore).toBeGreaterThanOrEqual(40);
    expect(res.signatureVersion).toBe("1.0.0");
    expect(res.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dynamically registers new signatures", () => {
    const newSig: PayloadSignature = {
      id: "SIG-CUSTOM-001",
      name: "Custom Zero-Day Malware Beacon",
      pattern: /beacon_c2_exfil/i,
      severity: "CRITICAL",
      category: "ZERO_DAY_EXPLOIT",
      version: "1.1.0",
    };

    dynamicFingerprintEngine.registerSignature(newSig);
    const res = computeDynamicFingerprint(
      "repo-1",
      "src/net.ts",
      "Malware",
      "const x = beacon_c2_exfil();",
    );

    expect(res.isZeroDayDetected).toBe(true);
    expect(res.matchedSignatures.some((s) => s.id === "SIG-CUSTOM-001")).toBe(true);
  });

  it("dynamically rotates signature database and updates active version", () => {
    const freshSignatures: PayloadSignature[] = [
      {
        id: "SIG-V2-001",
        name: "Rotated Signature 1",
        pattern: /rotated_payload_vector/,
        severity: "HIGH",
        category: "ZERO_DAY_EXPLOIT",
        version: "2.0.0",
      },
    ];

    dynamicFingerprintEngine.rotateSignatures(freshSignatures, "2.0.0");

    expect(dynamicFingerprintEngine.getActiveVersion()).toBe("2.0.0");
    expect(dynamicFingerprintEngine.getSignatures()).toHaveLength(1);

    const oldPayloadRes = computeDynamicFingerprint(
      "repo-1",
      "src/eval.ts",
      "RCE",
      "eval(String.fromCharCode(97))",
    );
    expect(oldPayloadRes.matchedSignatures).toHaveLength(0);

    const newPayloadRes = computeDynamicFingerprint(
      "repo-1",
      "src/eval.ts",
      "RCE",
      "rotated_payload_vector",
    );
    expect(newPayloadRes.matchedSignatures).toHaveLength(1);
    expect(newPayloadRes.signatureVersion).toBe("2.0.0");
  });

  it("integrates signature rotation directly via scanner instance", () => {
    const customSig: PayloadSignature = {
      id: "SIG-SCANNER-01",
      name: "Scanner Specific Signature",
      pattern: /scanner_zero_day_vector/,
      severity: "CRITICAL",
      category: "ZERO_DAY_EXPLOIT",
      version: "3.0.0",
    };

    scanner.rotateSignatureDatabase([customSig], "3.0.0");
    expect(scanner.getSignatureVersion()).toBe("3.0.0");

    const res = computeDynamicFingerprint(
      "repo-1",
      "src/test.ts",
      "Exploit",
      "scanner_zero_day_vector",
    );
    expect(res.matchedSignatures[0].id).toBe("SIG-SCANNER-01");
  });
});
