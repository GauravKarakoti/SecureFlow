import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  buildMerkleTree,
  generateMerkleInclusionProof,
  verifyMerkleInclusionProof,
  hashMerkleLeaf,
  hashMerkleInternal,
} from "./merkle-checkpoint";

function sha256Hex(val: string): string {
  return crypto.createHash("sha256").update(val).digest("hex");
}

describe("SHA-256 Binary Merkle Tree Checkpoints & O(log N) Inclusion Proofs (#2174)", () => {
  it("handles empty trees cleanly and throws on empty proof generation", () => {
    const empty = buildMerkleTree([]);
    expect(empty.root).toBeNull();
    expect(empty.leafCount).toBe(0);
    expect(empty.levels).toEqual([]);
    expect(() => generateMerkleInclusionProof(empty, 0)).toThrow();
  });

  it("handles a single-leaf tree (N = 1) with domain-separated leaf hash", () => {
    const h0 = sha256Hex("audit-event-0");
    const tree = buildMerkleTree([h0]);

    expect(tree.leafCount).toBe(1);
    expect(tree.root).toBe(hashMerkleLeaf(h0));

    const proof = generateMerkleInclusionProof(tree, 0);
    expect(proof.steps).toEqual([]);
    expect(verifyMerkleInclusionProof(h0, proof)).toEqual({
      valid: true,
      computedRoot: tree.root,
    });
  });

  it("verifies O(log N) inclusion proofs for every leaf across power-of-two and odd-sized trees", () => {
    for (const size of [2, 3, 4, 5, 7, 8, 13, 16]) {
      const leaves = Array.from({ length: size }, (_, i) => sha256Hex(`audit-record-${i}`));
      const tree = buildMerkleTree(leaves);

      expect(tree.root).toMatch(/^[a-f0-9]{64}$/);
      expect(tree.leafCount).toBe(size);

      for (let i = 0; i < size; i++) {
        const proof = generateMerkleInclusionProof(tree, i);
        expect(proof.steps.length).toBeLessThanOrEqual(Math.ceil(Math.log2(size)) + 1);
        const verification = verifyMerkleInclusionProof(leaves[i]!, proof);
        expect(verification.valid).toBe(true);
        expect(verification.computedRoot).toBe(tree.root);
      }
    }
  });

  it("rejects tampered leaf hashes, modified sibling hashes, and out-of-range indices", () => {
    const leaves = Array.from({ length: 6 }, (_, i) => sha256Hex(`event-${i}`));
    const tree = buildMerkleTree(leaves);

    expect(() => generateMerkleInclusionProof(tree, -1)).toThrow(RangeError);
    expect(() => generateMerkleInclusionProof(tree, 6)).toThrow(RangeError);

    const proof = generateMerkleInclusionProof(tree, 2);

    // Tampered leaf entry hash
    const tamperedLeafRes = verifyMerkleInclusionProof(sha256Hex("tampered-event-2"), proof);
    expect(tamperedLeafRes.valid).toBe(false);
    expect(tamperedLeafRes.computedRoot).not.toBe(tree.root);

    // Tampered sibling hash in proof
    const tamperedProof = {
      ...proof,
      steps: proof.steps.map((s, idx) =>
        idx === 0 ? { ...s, hash: sha256Hex("forged-sibling") } : s,
      ),
    };
    expect(verifyMerkleInclusionProof(leaves[2]!, tamperedProof).valid).toBe(false);
  });

  it("enforces domain separation between leaf (0x00) and internal (0x01) nodes", () => {
    const a = sha256Hex("left");
    const b = sha256Hex("right");
    expect(hashMerkleLeaf(`${a}${b}`)).not.toBe(hashMerkleInternal(a, b));
  });
});
