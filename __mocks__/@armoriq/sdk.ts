/**
 * Mock ArmorIQ SDK Module (Security Audit Cleaned - #1335)
 *
 * This mock contains purely synthetic test fixtures to simulate ArmorIQ runtime policy
 * decisions, cryptographic intent signature validation, proof verification, and upstream
 * timeouts/unreachable gateway errors without hardcoded live production credentials.
 */
import { vi } from "vitest";

/** Safe synthetic API key placeholder for ArmorIQ tests. */
export const SAFE_MOCK_ARMORIQ_API_KEY = "mock_api_key";
export const SAFE_MOCK_INTENT_TOKEN = "mock_token";

/**
 * Custom Error thrown when upstream ArmorIQ service times out.
 */
export class ArmorIQTimeoutError extends Error {
  public readonly code = "ETIMEDOUT";
  public readonly status = 504;
  constructor(message = "ArmorIQ policy verification timed out after 15000ms") {
    super(message);
    this.name = "ArmorIQTimeoutError";
  }
}

/**
 * Custom Error thrown when upstream ArmorIQ gateway is unreachable.
 */
export class ArmorIQUnreachableError extends Error {
  public readonly code = "ENOTFOUND";
  public readonly status = 503;
  constructor(message = "Upstream ArmorIQ verification gateway is unreachable") {
    super(message);
    this.name = "ArmorIQUnreachableError";
  }
}

export class ArmorIQError extends Error {
  public readonly status = 500;
  constructor(message = "ArmorIQ internal error") {
    super(message);
    this.name = "ArmorIQError";
  }
}

/**
 * Configurable simulation state for ArmorIQ SDK mocks.
 */
export const mockArmorIQState = {
  decision: "ALLOW" as "ALLOW" | "BLOCK" | "HOLD",
  ruleMatched: "DEFAULT_ZERO_TRUST_POLICY",
  justification: "Action permitted under verified developer scope",
  validProof: true,
  validSignature: true,
  shouldTimeout: false,
  shouldFailUnreachable: false,
  timeoutMs: 15_000,
};

/**
 * Intent token contract for ArmorIQ runtime policy evaluation.
 */
export interface IntentToken {
  tokenId?: string;
  token?: string;
  rawToken?: Record<string, unknown>;
  [key: string]: unknown;
}

export function setMockArmorIQDecision(
  decision: "ALLOW" | "BLOCK" | "HOLD",
  ruleMatched = "RULE_SPECIFIED",
  justification = "Policy decision applied",
) {
  mockArmorIQState.decision = decision;
  mockArmorIQState.ruleMatched = ruleMatched;
  mockArmorIQState.justification = justification;
}

/**
 * Helper to simulate blocked intents (prompt injection, tampered tokens).
 */
export function setMockArmorIQBlockedIntent(
  reason = "Intent token blocked: unauthorized prompt injection detected",
  rule = "PROMPT_INJECTION_DETECTED",
) {
  mockArmorIQState.decision = "BLOCK";
  mockArmorIQState.ruleMatched = rule;
  mockArmorIQState.justification = reason;
  mockArmorIQState.validProof = false;
  mockArmorIQState.validSignature = false;
}

/**
 * Helper to simulate organizational policy violations.
 */
export function setMockArmorIQPolicyViolation(
  rule = "POLICY_VIOLATION",
  justification = "Action violates organizational security policy",
) {
  mockArmorIQState.decision = "BLOCK";
  mockArmorIQState.ruleMatched = rule;
  mockArmorIQState.justification = justification;
}

/**
 * Helper to simulate degraded or offline ArmorIQ gateway states.
 */
export function setMockArmorIQDegraded(
  shouldFail = true,
  mode: "timeout" | "unreachable" = "unreachable",
) {
  if (mode === "timeout") {
    mockArmorIQState.shouldTimeout = shouldFail;
    mockArmorIQState.shouldFailUnreachable = false;
  } else {
    mockArmorIQState.shouldFailUnreachable = shouldFail;
    mockArmorIQState.shouldTimeout = false;
  }
}

export function setMockArmorIQTimeout(shouldTimeout: boolean) {
  mockArmorIQState.shouldTimeout = shouldTimeout;
}

export function setMockArmorIQUnreachable(shouldFail: boolean) {
  mockArmorIQState.shouldFailUnreachable = shouldFail;
}

export function setMockArmorIQProofValidity(valid: boolean) {
  mockArmorIQState.validProof = valid;
  mockArmorIQState.validSignature = valid;
}

export function resetMockArmorIQ() {
  mockArmorIQState.decision = "ALLOW";
  mockArmorIQState.ruleMatched = "DEFAULT_ZERO_TRUST_POLICY";
  mockArmorIQState.justification = "Action permitted under verified developer scope";
  mockArmorIQState.validProof = true;
  mockArmorIQState.validSignature = true;
  mockArmorIQState.shouldTimeout = false;
  mockArmorIQState.shouldFailUnreachable = false;
  mockArmorIQState.timeoutMs = 15_000;
}

export const mockVerifyIntentToken = vi.fn().mockImplementation(async (token: string) => {
  if (mockArmorIQState.shouldTimeout) {
    throw new ArmorIQTimeoutError();
  }
  if (mockArmorIQState.shouldFailUnreachable) {
    throw new ArmorIQUnreachableError();
  }
  return {
    allowed: mockArmorIQState.decision === "ALLOW",
    decision: mockArmorIQState.decision,
    ruleMatched: mockArmorIQState.ruleMatched,
    justification: mockArmorIQState.justification,
    proofHash: mockArmorIQState.validProof ? "mock_secret" : null,
    signature: mockArmorIQState.validSignature ? "mock_token" : null,
    token,
  };
});

export const mockSignIntent = vi
  .fn()
  .mockImplementation(async (intent: Record<string, unknown>) => {
    if (mockArmorIQState.shouldTimeout) {
      throw new ArmorIQTimeoutError();
    }
    if (mockArmorIQState.shouldFailUnreachable) {
      throw new ArmorIQUnreachableError();
    }
    return {
      signed: true,
      intentId: "intent_mock_12345",
      signature: "mock_token",
      intent,
    };
  });

export const mockEvaluatePolicy = vi
  .fn()
  .mockImplementation(async (context: Record<string, unknown>) => {
    if (mockArmorIQState.shouldTimeout) {
      throw new ArmorIQTimeoutError();
    }
    if (mockArmorIQState.shouldFailUnreachable) {
      throw new ArmorIQUnreachableError();
    }
    return {
      decision: mockArmorIQState.decision,
      ruleMatched: mockArmorIQState.ruleMatched,
      justification: mockArmorIQState.justification,
      context,
    };
  });

export const mockValidateProof = vi
  .fn()
  .mockImplementation((proofHash: string, signature: string) => {
    if (!proofHash || !signature) return false;
    return mockArmorIQState.validProof && mockArmorIQState.validSignature;
  });

export const mockRecordAuditLog = vi
  .fn()
  .mockImplementation(async (payload: Record<string, unknown>) => {
    if (mockArmorIQState.shouldTimeout) {
      throw new ArmorIQTimeoutError();
    }
    if (mockArmorIQState.shouldFailUnreachable) {
      throw new ArmorIQUnreachableError();
    }
    return {
      id: `armoriq_log_${Date.now()}`,
      status: "RECORDED",
      timestamp: new Date().toISOString(),
      ...payload,
    };
  });

export const mockVerifyToken = mockVerifyIntentToken;

export const mockGetIntentToken = vi
  .fn()
  .mockImplementation(async (plan: unknown, policy: unknown, ttl = 3600) => {
    if (mockArmorIQState.shouldTimeout) {
      throw new ArmorIQTimeoutError();
    }
    if (mockArmorIQState.shouldFailUnreachable) {
      throw new ArmorIQUnreachableError();
    }
    return {
      tokenId: "mock_token",
      token: SAFE_MOCK_INTENT_TOKEN,
      plan,
      policy,
      ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  });

export class ArmorIQClient {
  public apiKey: string;

  constructor(options: { apiKey?: string } = {}) {
    this.apiKey = options.apiKey || SAFE_MOCK_ARMORIQ_API_KEY;
  }

  public verifyToken = mockVerifyToken;
  public verifyIntentToken = mockVerifyIntentToken;
  public getIntentToken = mockGetIntentToken;
  public signIntent = mockSignIntent;
  public evaluatePolicy = mockEvaluatePolicy;
  public validateProof = mockValidateProof;
  public recordAuditLog = mockRecordAuditLog;
}

export default ArmorIQClient;
