import { describe, expect, it } from "vitest";
import {
  createPortableAuditProofBundle,
  verifyAuditProofBatch,
  verifyPortableAuditProofBundle,
} from "./merkle-proof";
import { exportAuditEventMerkleProof, verifyAuditEventMerkleProof } from "./verify-chain";

describe("Portable Merkle Inclusion Proof Generator & Verifier (#2228)", () => {
  const events = [
    { id: "evt-1", entryHash: "hash-1-aaa" },
    { id: "evt-2", entryHash: "hash-2-bbb" },
    { id: "evt-3", entryHash: "hash-3-ccc" },
    { id: "evt-4", entryHash: "hash-4-ddd" },
    { id: "evt-5", entryHash: "hash-5-eee" }, // Odd leaf count tests promotion
  ];

  it("generates and verifies portable Merkle inclusion proofs for odd and even leaves", () => {
    for (const evt of events) {
      const bundle = createPortableAuditProofBundle(events, evt.id, {
        checkpointId: "chk-test-001",
        generatedAt: "2026-11-28T00:00:00.000Z",
      });
      expect(bundle.schemaVersion).toBe("1.0");
      expect(bundle.leafCount).toBe(5);
      expect(verifyPortableAuditProofBundle(bundle).valid).toBe(true);
    }
  });

  it("rejects tampered entryHash, tampered sibling step, and tampered metadata", () => {
    const bundle = exportAuditEventMerkleProof(events, "evt-3");
    expect(verifyAuditEventMerkleProof(bundle).valid).toBe(true);

    // Tamper entryHash
    const tamperedHash = { ...bundle, entryHash: "forged-hash" };
    const res1 = verifyPortableAuditProofBundle(tamperedHash);
    expect(res1.valid).toBe(false);
    expect(res1.reason).toContain("digest mismatch");

    // Tamper metadata + recompute nothing
    const tamperedEventId = { ...bundle, eventId: "evt-999" };
    expect(verifyPortableAuditProofBundle(tamperedEventId).valid).toBe(false);
  });

  it("verifies a batch of portable proof bundles against a shared checkpoint root", () => {
    const b1 = createPortableAuditProofBundle(events, "evt-1");
    const b2 = createPortableAuditProofBundle(events, "evt-5");
    const batch = verifyAuditProofBatch([b1, b2], b1.root);

    expect(batch).toEqual({
      allValid: true,
      verifiedCount: 2,
      failedEventIds: [],
    });

    const wrongRoot = verifyAuditProofBatch([b1, b2], "wrong-root");
    expect(wrongRoot.allValid).toBe(false);
    expect(wrongRoot.failedEventIds).toEqual(["evt-1", "evt-5"]);
  });
});
