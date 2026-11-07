/**
 * ArmorIQ Cryptographic Pre-Execution Intent Signing (#1275)
 *
 * Implements intent capture and cryptographic signing before any autonomous agent
 * can trigger tools, read files, or contact external APIs.
 * Generates tamper-evident HMAC-SHA256 signatures and SHA-256 intent hashes.
 */

import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { agentRegistry, ARMORIQ_AGENT_IDS } from "./agent-registry";

export interface ExecutionPlan {
  goal: string;
  proposedTools: string[];
  targetPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SignedIntent {
  intentId: string;
  agentId: string;
  timestamp: number;
  plan: ExecutionPlan;
  intentHash: string;
  signature: string;
  intentToken: string;
  complianceMetadata: {
    frameworks: string[];
    tamperEvident: boolean;
  };
}

/**
 * Resolve the HMAC key used for intent provenance.
 *
 * A built-in fallback key is public knowledge, so a deployment that forgot to
 * set the environment variable would accept signatures forged by anyone who has
 * read this repository. There is no safe default: signing fails loudly instead.
 */
function resolveSigningKey(explicitKey?: string): string {
  const key = explicitKey?.trim() || process.env.ARMORIQ_PROOF_SIGNING_KEY?.trim();
  if (!key) {
    throw new Error(
      "ARMORIQ_PROOF_SIGNING_KEY is not configured; refusing to sign or verify ArmorIQ intents with a public fallback key.",
    );
  }
  return key;
}

/** True for a non-empty string after trimming. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True for a plain JSON-like object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the runtime shape of an execution plan.
 *
 * Signed intents can arrive from an API boundary, a queue payload, or a JWT
 * payload, none of which TypeScript checks. `computeIntentHash` spreads
 * `proposedTools` and `targetPaths`, so a missing or non-array field used to
 * throw before verification could return its fail-closed result.
 */
function isValidExecutionPlan(plan: unknown): plan is ExecutionPlan {
  if (!isRecord(plan)) return false;
  if (!isNonEmptyString(plan.goal)) return false;
  if (!Array.isArray(plan.proposedTools)) return false;
  if (!plan.proposedTools.every(isNonEmptyString)) return false;
  if (
    plan.targetPaths !== undefined &&
    (!Array.isArray(plan.targetPaths) || !plan.targetPaths.every(isNonEmptyString))
  ) {
    return false;
  }
  if (plan.metadata !== undefined && !isRecord(plan.metadata)) return false;
  return true;
}

/**
 * Computes a deterministic SHA-256 hash for an execution plan.
 */
export function computeIntentHash(
  intentId: string,
  agentId: string,
  plan: ExecutionPlan,
  timestamp: number,
): string {
  const normalizedPayload = JSON.stringify({
    intentId,
    agentId,
    goal: plan.goal,
    proposedTools: [...plan.proposedTools].sort(),
    targetPaths: plan.targetPaths ? [...plan.targetPaths].sort() : [],
    metadata: plan.metadata ?? {},
    timestamp,
  });

  return createHash("sha256").update(normalizedPayload).digest("hex");
}

/**
 * Creates an HMAC-SHA256 signature for the intent hash.
 */
/**
 * Constant-time comparison of two hex-encoded digests/signatures.
 *
 * Plain `!==` short-circuits on the first differing byte — a timing side
 * channel in a verify function. Matches the pattern already used by
 * webhook-verification.ts and outbound-dispatch.ts.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function signIntentHash(intentHash: string, signingKey?: string): string {
  return createHmac("sha256", resolveSigningKey(signingKey)).update(intentHash).digest("hex");
}

/**
 * Emits an execution plan and cryptographically signs it under ArmorIQ policy.
 */
export function declareAndSignIntent(
  agentId: string,
  plan: ExecutionPlan,
  signingKey?: string,
): SignedIntent {
  const policy = agentRegistry.get(agentId);
  const intentId = `intent_${randomUUID()}`;
  const timestamp = Date.now();
  const resolvedKey = resolveSigningKey(signingKey);

  const intentHash = computeIntentHash(intentId, agentId, plan, timestamp);
  const signature = signIntentHash(intentHash, resolvedKey);

  // Mint a mock/standard JWT-style intent token for downstream gateway compatibility
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: agentId,
      iid: intentId,
      tools: plan.proposedTools,
      exp: Math.floor((timestamp + 3600000) / 1000), // 1 hour expiry
      iat: Math.floor(timestamp / 1000),
      intentHash,
    }),
  ).toString("base64url");
  const intentToken = `${header}.${payload}.${signature.slice(0, 43)}`;

  return {
    intentId,
    agentId,
    timestamp,
    plan,
    intentHash,
    signature,
    intentToken,
    complianceMetadata: {
      frameworks: policy?.complianceFrameworks ?? ["SOC 2 (CC6.1)", "NIST SP 800-53 (AC-3)"],
      tamperEvident: true,
    },
  };
}

/**
 * Cryptographically verifies a signed intent and confirms its integrity.
 */
export function verifySignedIntent(
  signedIntent: SignedIntent,
  signingKey?: string,
): { valid: boolean; reason?: string } {
  if (!isRecord(signedIntent)) {
    return { valid: false, reason: "Missing or malformed signed intent structure." };
  }

  if (
    !isNonEmptyString(signedIntent.intentId) ||
    !isNonEmptyString(signedIntent.agentId) ||
    typeof signedIntent.timestamp !== "number" ||
    !Number.isFinite(signedIntent.timestamp) ||
    !isNonEmptyString(signedIntent.intentHash) ||
    !isNonEmptyString(signedIntent.signature) ||
    !isValidExecutionPlan(signedIntent.plan)
  ) {
    return {
      valid: false,
      reason: "Missing or malformed signed intent structure or execution plan.",
    };
  }

  let resolvedKey: string;
  try {
    resolvedKey = resolveSigningKey(signingKey);
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "ArmorIQ signing key is not configured.",
    };
  }

  let expectedHash: string;
  try {
    expectedHash = computeIntentHash(
      signedIntent.intentId,
      signedIntent.agentId,
      signedIntent.plan,
      signedIntent.timestamp,
    );
  } catch {
    return { valid: false, reason: "Malformed execution plan: intent hash could not be computed." };
  }

  if (expectedHash !== signedIntent.intentHash) {
    return {
      valid: false,
      reason: "Tamper detection: Intent hash does not match execution plan payload.",
    };
  }

  const expectedSig = signIntentHash(expectedHash, resolvedKey);
  if (!timingSafeEqualHex(expectedSig, signedIntent.signature)) {
    return {
      valid: false,
      reason: "Cryptographic signature verification failed (invalid provenance).",
    };
  }

  return { valid: true };
}
