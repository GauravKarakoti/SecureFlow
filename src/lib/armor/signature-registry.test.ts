/**
 * Regression tests for the signature registry (#527).
 *
 * Two defects are covered here:
 *   1. `rotateSignatures()` used to `clear()` the live map before registering
 *      the replacements, so one malformed entry left the shared engine with a
 *      partial or empty database and every later scan quietly matched nothing.
 *   2. A pattern carrying the `g`/`y` flag made `test()` stateful, so the same
 *      signature alternated between matching and not matching the same payload.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DynamicFingerprintEngine,
  SignatureValidationError,
  compileSignaturePattern,
  validateSignature,
  type PayloadSignature,
} from "./fingerprint";

const sig = (over: Partial<PayloadSignature> = {}): PayloadSignature => ({
  id: "SIG-TEST-001",
  name: "Test Signature",
  pattern: /test_payload_vector/,
  severity: "HIGH",
  category: "ZERO_DAY_EXPLOIT",
  version: "1.0.0",
  ...over,
});

describe("compileSignaturePattern", () => {
  it("strips the global flag so test() is stateless", () => {
    const compiled = compileSignaturePattern(/ghp_[a-z0-9]{4}/g);

    expect(compiled.flags).not.toContain("g");
    expect(compiled.test("ghp_abcd")).toBe(true);
    expect(compiled.test("ghp_abcd")).toBe(true);
    expect(compiled.test("ghp_abcd")).toBe(true);
  });

  it("strips the sticky flag too", () => {
    const compiled = compileSignaturePattern(/abc/y);

    expect(compiled.flags).not.toContain("y");
    expect(compiled.test("xxabc")).toBe(true);
    expect(compiled.test("xxabc")).toBe(true);
  });

  it("keeps meaningful flags and always matches case-insensitively", () => {
    const compiled = compileSignaturePattern(new RegExp("^eval", "ms"));

    expect(compiled.flags).toContain("m");
    expect(compiled.flags).toContain("s");
    expect(compiled.flags).toContain("i");
  });

  it("drops the global flag but keeps the rest", () => {
    const compiled = compileSignaturePattern(new RegExp("^eval", "gmi"));

    expect(compiled.flags).not.toContain("g");
    expect(compiled.flags).toContain("m");
    expect(compiled.flags).toContain("i");
  });

  it("compiles string patterns case-insensitively", () => {
    const compiled = compileSignaturePattern("union\\s+select");

    expect(compiled.test("UNION  SELECT")).toBe(true);
  });
});

describe("validateSignature", () => {
  it("accepts a well-formed signature", () => {
    expect(validateSignature(sig(), "s")).toEqual([]);
  });

  it("reports a missing id", () => {
    expect(validateSignature(sig({ id: "" }), "s")).toContain("s: missing a non-empty string id");
  });

  it("reports a whitespace-only id", () => {
    expect(validateSignature(sig({ id: "   " }), "s")).toHaveLength(1);
  });

  it("reports a missing pattern", () => {
    expect(validateSignature(sig({ pattern: "" }), "s")).toContain("s: missing a pattern");
  });

  it("reports an unparseable string pattern", () => {
    const issues = validateSignature(sig({ pattern: "([unclosed" }), "s");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("not a valid regular expression");
  });

  it("reports an unknown severity and category together", () => {
    const issues = validateSignature(
      sig({
        severity: "SEVERE" as PayloadSignature["severity"],
        category: "MAGIC" as PayloadSignature["category"],
      }),
      "s",
    );
    expect(issues).toHaveLength(2);
  });
});

describe("DynamicFingerprintEngine rotation atomicity", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
  });

  it("starts from the four built-in signatures", () => {
    expect(engine.getSignatures()).toHaveLength(4);
    expect(engine.getActiveVersion()).toBe("1.0.0");
  });

  it("keeps the existing database intact when a rotation batch is invalid", () => {
    const before = engine.getSignatures();

    expect(() =>
      engine.rotateSignatures([sig({ id: "SIG-OK" }), sig({ id: "", name: "broken" })], "2.0.0"),
    ).toThrow(SignatureValidationError);

    expect(engine.getSignatures()).toEqual(before);
    expect(engine.getActiveVersion()).toBe("1.0.0");
  });

  it("still detects built-in payloads after a rejected rotation", () => {
    try {
      engine.rotateSignatures([sig({ pattern: "([unclosed" })], "2.0.0");
    } catch {
      /* expected */
    }

    const res = engine.analyzePayload("repo", "src/a.ts", "RCE", "eval(atob('x'))");

    expect(res.matchedSignatures.length).toBeGreaterThan(0);
    expect(res.isZeroDayDetected).toBe(true);
  });

  it("reports every problem in the batch, not just the first", () => {
    let caught: SignatureValidationError | undefined;

    try {
      engine.rotateSignatures([
        sig({ id: "" }),
        sig({ id: "SIG-B", pattern: "([unclosed" }),
        sig({ id: "SIG-C", severity: "SEVERE" as PayloadSignature["severity"] }),
      ]);
    } catch (err) {
      caught = err as SignatureValidationError;
    }

    expect(caught).toBeInstanceOf(SignatureValidationError);
    expect(caught?.issues).toHaveLength(3);
  });

  it("rejects duplicate ids inside one batch", () => {
    expect(() => engine.rotateSignatures([sig({ id: "DUP" }), sig({ id: "DUP" })])).toThrow(
      /duplicate id/,
    );
  });

  it("refuses to rotate to an empty database", () => {
    expect(() => engine.rotateSignatures([])).toThrow(/disable detection entirely/);
    expect(engine.getSignatures()).toHaveLength(4);
  });

  it("rejects a non-array batch", () => {
    expect(() => engine.rotateSignatures(null as unknown as PayloadSignature[])).toThrow(
      SignatureValidationError,
    );
    expect(engine.getSignatures()).toHaveLength(4);
  });

  it("applies a valid rotation and bumps the version when none is given", () => {
    engine.rotateSignatures([sig({ id: "SIG-NEW" })]);

    expect(engine.getSignatures()).toHaveLength(1);
    expect(engine.getActiveVersion()).toBe("2.0.0");
  });
});

describe("DynamicFingerprintEngine batch updates", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
  });

  it("does not partially apply an invalid update batch", () => {
    expect(() =>
      engine.updateSignatureDatabase([sig({ id: "SIG-GOOD" }), sig({ id: "" })], "1.5.0"),
    ).toThrow(SignatureValidationError);

    expect(engine.getSignatures().some((s) => s.id === "SIG-GOOD")).toBe(false);
    expect(engine.getSignatures()).toHaveLength(4);
    expect(engine.getActiveVersion()).toBe("1.0.0");
  });

  it("applies a fully valid update batch on top of the defaults", () => {
    engine.updateSignatureDatabase([sig({ id: "SIG-GOOD" })], "1.5.0");

    expect(engine.getSignatures()).toHaveLength(5);
    expect(engine.getActiveVersion()).toBe("1.5.0");
  });

  it("leaves the database untouched when registerSignature rejects", () => {
    expect(() => engine.registerSignature(sig({ pattern: "([unclosed" }))).toThrow(
      SignatureValidationError,
    );
    expect(engine.getSignatures()).toHaveLength(4);
  });
});

describe("DynamicFingerprintEngine stateless matching", () => {
  let engine: DynamicFingerprintEngine;

  beforeEach(() => {
    engine = new DynamicFingerprintEngine();
  });

  it("matches a global-flagged signature consistently across snippets", () => {
    engine.registerSignature(
      sig({ id: "SIG-GLOBAL", pattern: /ghp_[a-z0-9]{4}/g, severity: "CRITICAL" }),
    );

    const results = [0, 1, 2, 3].map(
      () =>
        engine.analyzePayload("repo", "src/a.ts", "Secret", "token = ghp_abcd").matchedSignatures,
    );

    for (const matched of results) {
      expect(matched.some((s) => s.id === "SIG-GLOBAL")).toBe(true);
    }
  });

  it("produces a stable risk score for identical payloads", () => {
    engine.registerSignature(sig({ id: "SIG-GLOBAL", pattern: /secret_value/g }));

    const first = engine.analyzePayload("repo", "src/a.ts", "Secret", "secret_value").riskScore;
    const second = engine.analyzePayload("repo", "src/a.ts", "Secret", "secret_value").riskScore;

    expect(second).toBe(first);
  });

  it("does not expose the internal compiled pattern", () => {
    const [first] = engine.getSignatures();
    expect(first).not.toHaveProperty("compiled");
  });

  it("keeps matchedSignatures free of the internal compiled pattern", () => {
    const res = engine.analyzePayload("repo", "src/a.ts", "RCE", "eval(atob('x'))");
    expect(res.matchedSignatures[0]).not.toHaveProperty("compiled");
  });

  it("caps the risk score at 100", () => {
    const res = engine.analyzePayload(
      "repo",
      "src/a.ts",
      "Mixed",
      "eval(atob('x')); __proto__['a']= ; UNION SELECT; ghp_" + "a".repeat(36),
    );
    expect(res.riskScore).toBeLessThanOrEqual(100);
  });
});
