import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { HashChain } from "./hashChain";

describe("HashChain.getGenesisHash", () => {
  it("is the pinned SHA-256 of the genesis marker", () => {
    // Pin the constant: a regression here silently invalidates every ledger.
    expect(HashChain.getGenesisHash()).toBe(
      crypto.createHash("sha256").update("SECUREFLOW_GENESIS").digest("hex"),
    );
  });

  it("is stable across calls", () => {
    expect(HashChain.getGenesisHash()).toBe(HashChain.getGenesisHash());
  });
});

describe("HashChain.calculateHash", () => {
  const timestamp = new Date("2026-01-02T03:04:05.000Z");

  it("chains previousHash, ISO timestamp, action and payload with pipe separators", () => {
    const expected = crypto
      .createHash("sha256")
      .update("prev|2026-01-02T03:04:05.000Z|SCAN|{}" as string)
      .digest("hex");
    expect(HashChain.calculateHash("prev", timestamp, "SCAN", "{}")).toBe(expected);
  });

  it("is deterministic for identical inputs", () => {
    const a = HashChain.calculateHash("prev", timestamp, "SCAN", "{}");
    const b = HashChain.calculateHash("prev", timestamp, "SCAN", "{}");
    expect(a).toBe(b);
  });

  it("changes when any single segment changes", () => {
    const base = HashChain.calculateHash("prev", timestamp, "SCAN", "{}");
    expect(HashChain.calculateHash("other", timestamp, "SCAN", "{}")).not.toBe(base);
    expect(
      HashChain.calculateHash("prev", new Date("2026-01-02T03:04:06.000Z"), "SCAN", "{}"),
    ).not.toBe(base);
    expect(HashChain.calculateHash("prev", timestamp, "LOGIN", "{}")).not.toBe(base);
    expect(HashChain.calculateHash("prev", timestamp, "SCAN", '{"x":1}')).not.toBe(base);
  });

  it("handles an empty previousHash (genesis edge) and empty payload", () => {
    const hash = HashChain.calculateHash("", timestamp, "SCAN", "");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
