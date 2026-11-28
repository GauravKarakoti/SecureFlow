import crypto from "node:crypto";
import {
  buildMerkleTree,
  generateMerkleInclusionProof,
  verifyMerkleInclusionProof,
  type MerkleInclusionProof,
} from "./merkle-checkpoint";

/**
 * Tamper-Evident Portable Merkle Inclusion Proof Generator & Offline Verifier (#2228).
 *
 * Wraps `merkle-checkpoint.ts` to produce self-contained, integrity-sealed
 * JSON proof bundles for individual audit events and batch verification.
 */

export interface AuditProofEventInput {
  id: string;
  entryHash: string;
}

export interface PortableAuditProofBundle {
  schemaVersion: "1.0";
  checkpointId: string;
  eventId: string;
  entryHash: string;
  leafCount: number;
  root: string;
  proof: MerkleInclusionProof;
  generatedAt: string;
  bundleDigest: string;
}

export interface PortableProofVerificationResult {
  valid: boolean;
  reason?: string;
  computedRoot?: string;
}

function computeBundleDigest(payload: Omit<PortableAuditProofBundle, "bundleDigest">): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Build a portable, tamper-evident Merkle inclusion proof bundle for a target audit event.
 */
export function createPortableAuditProofBundle(
  events: readonly AuditProofEventInput[],
  targetEventId: string,
  options: { checkpointId?: string; generatedAt?: string } = {},
): PortableAuditProofBundle {
  if (!events || events.length === 0) {
    throw new Error("Cannot generate proof bundle from empty audit event batch.");
  }

  const targetIndex = events.findIndex((e) => e.id === targetEventId);
  if (targetIndex === -1) {
    throw new Error(`Target audit event "${targetEventId}" not found in batch.`);
  }

  const entryHashes = events.map((e) => e.entryHash);
  const tree = buildMerkleTree(entryHashes);
  if (!tree.root) {
    throw new Error("Merkle tree produced an empty root.");
  }

  const proof = generateMerkleInclusionProof(tree, targetIndex);
  const targetEvent = events[targetIndex]!;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const checkpointId = options.checkpointId ?? `chk-${tree.root.slice(0, 12)}-${tree.leafCount}`;

  const unsignedBundle: Omit<PortableAuditProofBundle, "bundleDigest"> = {
    schemaVersion: "1.0",
    checkpointId,
    eventId: targetEvent.id,
    entryHash: targetEvent.entryHash,
    leafCount: tree.leafCount,
    root: tree.root,
    proof,
    generatedAt,
  };

  return {
    ...unsignedBundle,
    bundleDigest: computeBundleDigest(unsignedBundle),
  };
}

/**
 * Stateless offline verification of a PortableAuditProofBundle.
 */
export function verifyPortableAuditProofBundle(
  bundle: PortableAuditProofBundle,
): PortableProofVerificationResult {
  if (!bundle || bundle.schemaVersion !== "1.0") {
    return { valid: false, reason: "Unsupported or missing proof bundle schemaVersion." };
  }
  if (!bundle.root || !bundle.entryHash || !bundle.proof) {
    return { valid: false, reason: "Proof bundle is missing required cryptographic fields." };
  }

  const { bundleDigest, ...unsigned } = bundle;
  const expectedDigest = computeBundleDigest(unsigned);
  const bufA = Buffer.from(expectedDigest, "utf8");
  const bufB = Buffer.from(bundleDigest ?? "", "utf8");
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { valid: false, reason: "Bundle digest mismatch (metadata or proof tampered)." };
  }

  if (bundle.proof.root !== bundle.root) {
    return { valid: false, reason: "Proof root does not match bundle root." };
  }

  const merkleCheck = verifyMerkleInclusionProof(bundle.entryHash, bundle.proof);
  if (!merkleCheck.valid) {
    return {
      valid: false,
      reason: "Merkle inclusion proof failed cryptographic root verification.",
      computedRoot: merkleCheck.computedRoot,
    };
  }

  return {
    valid: true,
    computedRoot: merkleCheck.computedRoot,
  };
}

/**
 * Verify a batch of portable proof bundles against an expected checkpoint root.
 */
export function verifyAuditProofBatch(
  bundles: readonly PortableAuditProofBundle[],
  expectedRoot: string,
): { allValid: boolean; verifiedCount: number; failedEventIds: string[] } {
  const failedEventIds: string[] = [];
  let verifiedCount = 0;

  for (const bundle of bundles) {
    const res = verifyPortableAuditProofBundle(bundle);
    if (res.valid && bundle.root === expectedRoot) {
      verifiedCount++;
    } else {
      failedEventIds.push(bundle.eventId);
    }
  }

  return {
    allValid: failedEventIds.length === 0 && bundles.length > 0,
    verifiedCount,
    failedEventIds,
  };
}
