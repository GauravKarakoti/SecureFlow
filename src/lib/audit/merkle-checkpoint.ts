import crypto from "node:crypto";

/**
 * SHA-256 Binary Merkle Tree Checkpoint & O(log N) Inclusion Proof Engine (#2174).
 *
 * Uses RFC 6962 style domain separation:
 * - Leaf nodes:     SHA-256(0x00 || leafBytes)
 * - Internal nodes: SHA-256(0x01 || leftBytes || rightBytes)
 * This prevents second-preimage / leaf-extension attacks.
 */

export interface MerkleTree {
  root: string | null;
  leafCount: number;
  levels: string[][];
}

export interface MerkleProofStep {
  position: "left" | "right";
  hash: string;
}

export interface MerkleInclusionProof {
  leafIndex: number;
  leafHash: string;
  root: string;
  steps: MerkleProofStep[];
}

export interface MerkleVerificationResult {
  valid: boolean;
  computedRoot: string;
}

export function hashMerkleLeaf(entryHash: string): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(entryHash, "utf8")]))
    .digest("hex");
}

export function hashMerkleInternal(leftHex: string, rightHex: string): string {
  return crypto
    .createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from(leftHex, "utf8"),
        Buffer.from(rightHex, "utf8"),
      ]),
    )
    .digest("hex");
}

/**
 * Builds a deterministic binary Merkle tree over an ordered list of audit entry hashes.
 */
export function buildMerkleTree(entryHashes: readonly string[]): MerkleTree {
  if (!entryHashes || entryHashes.length === 0) {
    return { root: null, leafCount: 0, levels: [] };
  }

  let currentLevel = entryHashes.map((h) => hashMerkleLeaf(h));
  const levels: string[][] = [currentLevel];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = currentLevel[i + 1];
      if (right !== undefined) {
        nextLevel.push(hashMerkleInternal(left, right));
      } else {
        // Odd trailing node promoted cleanly to the parent level
        nextLevel.push(left);
      }
    }
    levels.push(nextLevel);
    currentLevel = nextLevel;
  }

  return {
    root: currentLevel[0]!,
    leafCount: entryHashes.length,
    levels,
  };
}

/**
 * Generates an O(log N) Merkle inclusion proof for the entry at `leafIndex`.
 */
export function generateMerkleInclusionProof(
  tree: MerkleTree,
  leafIndex: number,
): MerkleInclusionProof {
  if (!tree.root || tree.leafCount === 0) {
    throw new Error("Cannot generate inclusion proof from an empty Merkle tree.");
  }
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.leafCount) {
    throw new RangeError(
      `Leaf index ${leafIndex} out of bounds for tree with ${tree.leafCount} leaves.`,
    );
  }

  const steps: MerkleProofStep[] = [];
  let idx = leafIndex;

  for (let levelIdx = 0; levelIdx < tree.levels.length - 1; levelIdx++) {
    const level = tree.levels[levelIdx]!;
    const isRightNode = idx % 2 === 1;
    const siblingIdx = isRightNode ? idx - 1 : idx + 1;

    if (siblingIdx < level.length) {
      steps.push({
        position: isRightNode ? "left" : "right",
        hash: level[siblingIdx]!,
      });
    }

    idx = Math.floor(idx / 2);
  }

  return {
    leafIndex,
    leafHash: tree.levels[0]![leafIndex]!,
    root: tree.root,
    steps,
  };
}

/**
 * Independently verifies an audit entry hash against a Merkle inclusion proof.
 */
export function verifyMerkleInclusionProof(
  entryHash: string,
  proof: MerkleInclusionProof,
): MerkleVerificationResult {
  let current = hashMerkleLeaf(entryHash);

  for (const step of proof.steps) {
    if (step.position === "left") {
      current = hashMerkleInternal(step.hash, current);
    } else {
      current = hashMerkleInternal(current, step.hash);
    }
  }

  const bufComputed = Buffer.from(current, "utf8");
  const bufExpected = Buffer.from(proof.root, "utf8");
  const valid =
    bufComputed.length === bufExpected.length && crypto.timingSafeEqual(bufComputed, bufExpected);

  return {
    valid,
    computedRoot: current,
  };
}
