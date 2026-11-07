import { describe, expect, it } from "vitest";
import { declareAndSignIntent, timingSafeEqualHex, verifySignedIntent } from "./intent-signing";

const PLAN = {
  goal: "remediate finding",
  proposedTools: ["fs.read"],
  targetPaths: ["src/index.ts"],
};

describe("timingSafeEqualHex", () => {
  it("accepts identical hex digests", () => {
    expect(timingSafeEqualHex("ab12cd", "ab12cd")).toBe(true);
    expect(timingSafeEqualHex("AB12CD", "ab12cd")).toBe(true);
  });

  it("rejects differing, truncated, or non-hex input", () => {
    expect(timingSafeEqualHex("ab12cd", "ab12ce")).toBe(false);
    expect(timingSafeEqualHex("ab12cd", "ab12")).toBe(false);
    expect(timingSafeEqualHex("ab12cd", "not-hex!")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });
});

describe("declareAndSignIntent / verifySignedIntent", () => {
  it("round-trips a freshly signed intent", () => {
    const intent = declareAndSignIntent("test-agent", PLAN, "test-key");
    expect(verifySignedIntent(intent, "test-key").valid).toBe(true);
  });

  it("rejects a tampered execution plan", () => {
    const intent = declareAndSignIntent("test-agent", PLAN, "test-key");
    const tampered = {
      ...intent,
      plan: { ...intent.plan, proposedTools: ["fs.read", "shell.exec"] },
    };
    const result = verifySignedIntent(tampered, "test-key");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Tamper detection");
  });

  it("rejects a signature made with a different key", () => {
    const intent = declareAndSignIntent("test-agent", PLAN, "test-key");
    const result = verifySignedIntent(intent, "wrong-key");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("signature verification failed");
  });

  it("rejects a malformed signature without throwing", () => {
    const intent = declareAndSignIntent("test-agent", PLAN, "test-key");
    const malformed = { ...intent, signature: "zzz-not-hex" };
    expect(verifySignedIntent(malformed, "test-key").valid).toBe(false);
  });
});
