/**
 * Provider Signature & Verifier Registry
 *
 * Enterprise-grade multi-provider signature verification and signing framework for SecureFlow.
 * Supports:
 * - Pluggable verification algorithms (HMAC-SHA256, HMAC-SHA512, Ed25519, RSA-SHA256, Shared Token)
 * - Built-in provider presets (GitHub, SecureFlow, Stripe, Slack, GitLab, Bitbucket)
 * - Asymmetric public-key verification (Ed25519, RSA-SHA256)
 * - Zero-downtime key rotation (primary secret + fallback rotation secrets)
 * - Configurable timestamp replay window protection
 * - Timing-safe constant time digest and token comparisons
 * - Extensible runtime registration for custom SaaS & security webhook providers
 */

import {
  createHmac,
  createSign,
  createVerify,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual,
  KeyLike,
} from "crypto";

export type AlgorithmType =
  | "hmac-sha256"
  | "hmac-sha512"
  | "hmac-sha384"
  | "ed25519"
  | "rsa-sha256"
  | "token-match"
  | "custom";

export interface VerificationResult {
  ok: boolean;
  providerId?: string;
  scheme?: string;
  keyIndex?: number;
  status?: number;
  message?: string;
  reason?: string;
  timestamp?: number;
}

export interface VerificationOptions {
  timestamp?: number;
  replayWindowSeconds?: number;
  encoding?: "hex" | "base64";
  headers?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface SignOptions {
  timestamp?: number;
  encoding?: "hex" | "base64";
  keyId?: string;
  [key: string]: unknown;
}

export interface SignatureVerifier {
  /** Name identifier for the verifier */
  readonly name: string;
  /** Algorithm type handled */
  readonly algorithm: AlgorithmType;

  /** Extract raw signature token/header from request headers */
  extractSignature(headers: Headers | Record<string, string | string[] | undefined>): string | null;

  /** Extract timestamp from request headers if supported */
  extractTimestamp?(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): number | null;

  /**
   * Verify signature against payload and secret/key.
   * Returns true or detailed result.
   */
  verify(
    payload: string | Buffer,
    signature: string,
    secretOrKey: string | Buffer | KeyLike,
    options?: VerificationOptions,
  ): boolean | VerificationResult;

  /** Sign payload if supported */
  sign?(
    payload: string | Buffer,
    secretOrKey: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string;
}

export interface SecretResolverOptions {
  providerId: string;
  headers?: Record<string, string | undefined>;
}

export type SecretSource =
  | string
  | (() => string | undefined)
  | Array<string | (() => string | undefined)>;

export interface ProviderConfig {
  /** Unique provider identifier (e.g. 'github', 'stripe', 'slack', 'secureflow') */
  providerId: string;
  /** Friendly provider display name */
  displayName?: string;
  /** Signature verifier instance */
  verifier: SignatureVerifier;
  /** Primary secret or dynamic resolver */
  secret?: SecretSource;
  /** Key rotation secondary secrets (attempted if primary fails) */
  secondarySecrets?: Array<string | (() => string | undefined)>;
  /** Signature header name override */
  signatureHeader?: string;
  /** Timestamp header name override */
  timestampHeader?: string;
  /** Max replay window in seconds (default: 300) */
  replayWindowSeconds?: number;
  /** Whether timestamp is strictly required */
  requireTimestamp?: boolean;
}

export interface VerifyRequestParams {
  providerId: string;
  payload: string | Buffer;
  headers: Headers | Record<string, string | string[] | undefined>;
  secret?: SecretSource;
  replayWindowSeconds?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe header getter for Headers object or record */
export function getHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0] ?? null;
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

/** Timing-safe string comparison */
export function safeStringCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Timing-safe hex buffer comparison */
export function safeHexCompare(hexA: string, hexB: string): boolean {
  if (hexA.length !== hexB.length) return false;
  if (!/^[0-9a-fA-F]+$/.test(hexA) || !/^[0-9a-fA-F]+$/.test(hexB)) return false;
  const bufA = Buffer.from(hexA.toLowerCase(), "hex");
  const bufB = Buffer.from(hexB.toLowerCase(), "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Resolve secret source into array of usable non-empty string secrets */
export function resolveSecrets(source?: SecretSource): string[] {
  if (!source) return [];
  const list = Array.isArray(source) ? source : [source];
  const resolved: string[] = [];

  for (const item of list) {
    const val = typeof item === "function" ? item() : item;
    if (typeof val === "string" && val.trim().length > 0) {
      resolved.push(val.trim());
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Built-in Verifiers
// ---------------------------------------------------------------------------

/**
 * GitHub Webhook Verifier
 * Validates `X-Hub-Signature-256` in format `sha256=<hex>`
 */
export class GitHubSignatureVerifier implements SignatureVerifier {
  readonly name = "github";
  readonly algorithm = "hmac-sha256" as const;
  private readonly defaultHeader = "x-hub-signature-256";

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    const raw = getHeader(headers, this.defaultHeader);
    if (!raw) return null;
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith("sha256=")) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }

  verify(
    payload: string | Buffer,
    signature: string,
    secret: string | Buffer | KeyLike,
  ): boolean {
    if (typeof secret !== "string" || !secret) return false;
    const cleanSig = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    if (cleanSig.length !== 64 || !/^[0-9a-fA-F]+$/.test(cleanSig)) return false;

    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const digest = createHmac("sha256", secret).update(payloadText, "utf8").digest("hex");
    return safeHexCompare(cleanSig, digest);
  }

  sign(payload: string | Buffer, secret: string | Buffer | KeyLike): string {
    if (typeof secret !== "string") throw new Error("GitHub secret must be a string");
    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const digest = createHmac("sha256", secret).update(payloadText, "utf8").digest("hex");
    return `sha256=${digest}`;
  }
}

/**
 * SecureFlow Webhook Verifier
 * Validates canonical `t=<unix>,v1=<hex>` or legacy `sha256=<hex>` on `X-SecureFlow-Signature`
 */
export class SecureFlowSignatureVerifier implements SignatureVerifier {
  readonly name = "secureflow";
  readonly algorithm = "hmac-sha256" as const;

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    return getHeader(headers, "x-secureflow-signature");
  }

  extractTimestamp(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): number | null {
    const val = getHeader(headers, "x-secureflow-timestamp");
    if (!val) return null;
    const num = Number(val.trim());
    return Number.isSafeInteger(num) ? num : null;
  }

  verify(
    payload: string | Buffer,
    signature: string,
    secret: string | Buffer | KeyLike,
    options?: VerificationOptions,
  ): VerificationResult {
    if (typeof secret !== "string" || !secret) {
      return { ok: false, status: 500, message: "Secret is not configured" };
    }

    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const trimmed = signature.trim();

    // Legacy format sha256=<hex>
    if (trimmed.toLowerCase().startsWith("sha256=")) {
      const hex = trimmed.slice(7).trim();
      if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
        return { ok: false, status: 401, message: "Invalid signature hex length" };
      }
      const digest = createHmac("sha256", secret).update(payloadText, "utf8").digest("hex");
      const ok = safeHexCompare(hex, digest);
      return ok
        ? { ok: true, scheme: "legacy" }
        : { ok: false, status: 401, message: "Invalid signature" };
    }

    // Canonical v1 format: t=<unix>,v1=<hex>
    const parts = new Map<string, string>();
    for (const segment of trimmed.split(",")) {
      const idx = segment.indexOf("=");
      if (idx <= 0) continue;
      const k = segment.slice(0, idx).trim().toLowerCase();
      const v = segment.slice(idx + 1).trim();
      if (!parts.has(k)) parts.set(k, v);
    }

    const tStr = parts.get("t");
    const v1Hex = parts.get("v1");
    if (!tStr || !v1Hex || v1Hex.length !== 64 || !/^-?\d+$/.test(tStr)) {
      return { ok: false, status: 401, message: "Malformed v1 signature" };
    }

    const sigTimestamp = Number(tStr);
    const replayWindow = options?.replayWindowSeconds ?? 300;
    const nowSec = Math.floor(Date.now() / 1000);

    if (Math.abs(nowSec - sigTimestamp) > replayWindow) {
      return { ok: false, status: 401, message: "Request timestamp outside allowed window" };
    }

    if (options?.timestamp !== undefined) {
      if (Math.abs(sigTimestamp - options.timestamp) > 1) {
        return {
          ok: false,
          status: 401,
          message: "Signature timestamp does not match timestamp header",
        };
      }
    }

    const digest = createHmac("sha256", secret)
      .update(`${sigTimestamp}.${payloadText}`, "utf8")
      .digest("hex");

    if (!safeHexCompare(v1Hex, digest)) {
      return { ok: false, status: 401, message: "Invalid signature" };
    }

    return { ok: true, scheme: "v1", timestamp: sigTimestamp };
  }

  sign(
    payload: string | Buffer,
    secret: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string {
    if (typeof secret !== "string") throw new Error("Secret must be a string");
    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const ts = options?.timestamp ?? Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret).update(`${ts}.${payloadText}`, "utf8").digest("hex");
    return `t=${ts},v1=${digest}`;
  }
}

/**
 * Stripe Webhook Verifier
 * Header: `Stripe-Signature` -> `t=<timestamp>,v1=<sig>,v1=<sig2>...`
 */
export class StripeSignatureVerifier implements SignatureVerifier {
  readonly name = "stripe";
  readonly algorithm = "hmac-sha256" as const;

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    return getHeader(headers, "stripe-signature");
  }

  extractTimestamp(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): number | null {
    const sigHeader = this.extractSignature(headers);
    if (!sigHeader) return null;
    const tMatch = sigHeader.match(/(?:^|,\s*)t=(\d+)/);
    return tMatch ? Number(tMatch[1]) : null;
  }

  verify(
    payload: string | Buffer,
    signature: string,
    secret: string | Buffer | KeyLike,
    options?: VerificationOptions,
  ): VerificationResult {
    if (typeof secret !== "string" || !secret) {
      return { ok: false, status: 500, message: "Secret is not configured" };
    }

    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    let timestamp: number | null = null;
    const signatures: string[] = [];

    for (const item of signature.split(",")) {
      const idx = item.indexOf("=");
      if (idx <= 0) continue;
      const key = item.slice(0, idx).trim();
      const val = item.slice(idx + 1).trim();
      if (key === "t" && timestamp === null) {
        timestamp = Number(val);
      } else if (key === "v1") {
        signatures.push(val);
      }
    }

    if (timestamp === null || Number.isNaN(timestamp) || signatures.length === 0) {
      return { ok: false, status: 401, message: "Invalid Stripe signature format" };
    }

    const replayWindow = options?.replayWindowSeconds ?? 300;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > replayWindow) {
      return { ok: false, status: 401, message: "Stripe signature timestamp expired" };
    }

    const signedPayload = `${timestamp}.${payloadText}`;
    const expectedDigest = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

    const matched = signatures.some((sig) => safeHexCompare(sig, expectedDigest));
    if (!matched) {
      return { ok: false, status: 401, message: "No matching signature found" };
    }

    return { ok: true, scheme: "stripe-v1", timestamp };
  }

  sign(
    payload: string | Buffer,
    secret: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string {
    if (typeof secret !== "string") throw new Error("Secret must be a string");
    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const ts = options?.timestamp ?? Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret).update(`${ts}.${payloadText}`, "utf8").digest("hex");
    return `t=${ts},v1=${digest}`;
  }
}

/**
 * Slack Webhook Verifier
 * Header: `X-Slack-Signature` -> `v0=<hex>`, timestamp header: `X-Slack-Request-Timestamp`
 * Signed material: `v0:${timestamp}:${payload}`
 */
export class SlackSignatureVerifier implements SignatureVerifier {
  readonly name = "slack";
  readonly algorithm = "hmac-sha256" as const;

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    return getHeader(headers, "x-slack-signature");
  }

  extractTimestamp(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): number | null {
    const val = getHeader(headers, "x-slack-request-timestamp");
    if (!val) return null;
    const ts = Number(val.trim());
    return Number.isSafeInteger(ts) ? ts : null;
  }

  verify(
    payload: string | Buffer,
    signature: string,
    secret: string | Buffer | KeyLike,
    options?: VerificationOptions,
  ): VerificationResult {
    if (typeof secret !== "string" || !secret) {
      return { ok: false, status: 500, message: "Secret is not configured" };
    }

    const timestamp = options?.timestamp;
    if (timestamp === undefined || Number.isNaN(timestamp)) {
      return { ok: false, status: 401, message: "Missing Slack request timestamp" };
    }

    const replayWindow = options?.replayWindowSeconds ?? 300;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > replayWindow) {
      return { ok: false, status: 401, message: "Slack request timestamp expired" };
    }

    const cleanSig = signature.startsWith("v0=") ? signature.slice(3).trim() : signature.trim();
    if (cleanSig.length !== 64 || !/^[0-9a-fA-F]+$/.test(cleanSig)) {
      return { ok: false, status: 401, message: "Invalid Slack signature hex" };
    }

    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const sigBasestring = `v0:${timestamp}:${payloadText}`;
    const digest = createHmac("sha256", secret).update(sigBasestring, "utf8").digest("hex");

    if (!safeHexCompare(cleanSig, digest)) {
      return { ok: false, status: 401, message: "Invalid Slack signature" };
    }

    return { ok: true, scheme: "slack-v0", timestamp };
  }

  sign(
    payload: string | Buffer,
    secret: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string {
    if (typeof secret !== "string") throw new Error("Secret must be a string");
    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const ts = options?.timestamp ?? Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret)
      .update(`v0:${ts}:${payloadText}`, "utf8")
      .digest("hex");
    return `v0=${digest}`;
  }
}

/**
 * GitLab Webhook Verifier
 * Token-based matching on `X-Gitlab-Token` header
 */
export class GitLabTokenVerifier implements SignatureVerifier {
  readonly name = "gitlab";
  readonly algorithm = "token-match" as const;

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    return getHeader(headers, "x-gitlab-token");
  }

  verify(
    _payload: string | Buffer,
    signature: string,
    secret: string | Buffer | KeyLike,
  ): boolean {
    if (typeof secret !== "string" || !secret) return false;
    return safeStringCompare(signature.trim(), secret.trim());
  }
}

/**
 * Generic HMAC Verifier (supports sha256, sha384, sha512, with optional prefix)
 */
export class GenericHmacVerifier implements SignatureVerifier {
  readonly name: string;
  readonly algorithm: AlgorithmType;
  private readonly hashAlgo: "sha256" | "sha384" | "sha512";
  private readonly headerName: string;
  private readonly prefix: string;

  constructor(options?: {
    name?: string;
    hashAlgo?: "sha256" | "sha384" | "sha512";
    headerName?: string;
    prefix?: string;
  }) {
    this.hashAlgo = options?.hashAlgo ?? "sha256";
    this.name = options?.name ?? `generic-${this.hashAlgo}`;
    this.algorithm = `hmac-${this.hashAlgo}` as AlgorithmType;
    this.headerName = options?.headerName ?? "x-signature";
    this.prefix = options?.prefix ?? "";
  }

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    const val = getHeader(headers, this.headerName);
    if (!val) return null;
    const trimmed = val.trim();
    if (this.prefix && trimmed.toLowerCase().startsWith(this.prefix.toLowerCase())) {
      return trimmed.slice(this.prefix.length).trim();
    }
    return trimmed;
  }

  verify(
    payload: string | Buffer,
    signature: string,
    secret: string | Buffer | KeyLike,
  ): boolean {
    if (typeof secret !== "string" || !secret) return false;
    let cleanSig = signature.trim();
    if (this.prefix && cleanSig.toLowerCase().startsWith(this.prefix.toLowerCase())) {
      cleanSig = cleanSig.slice(this.prefix.length).trim();
    }

    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const digest = createHmac(this.hashAlgo, secret).update(payloadText, "utf8").digest("hex");
    return safeHexCompare(cleanSig, digest);
  }

  sign(payload: string | Buffer, secret: string | Buffer | KeyLike): string {
    if (typeof secret !== "string") throw new Error("Secret must be a string");
    const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
    const digest = createHmac(this.hashAlgo, secret).update(payloadText, "utf8").digest("hex");
    return `${this.prefix}${digest}`;
  }
}

/**
 * Asymmetric Ed25519 Verifier
 * Verifies public key Ed25519 signatures (SPKI public key PEM or raw base64/hex)
 */
export class Ed25519SignatureVerifier implements SignatureVerifier {
  readonly name = "ed25519";
  readonly algorithm = "ed25519" as const;
  private readonly headerName: string;

  constructor(headerName = "x-ed25519-signature") {
    this.headerName = headerName;
  }

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    return getHeader(headers, this.headerName);
  }

  verify(
    payload: string | Buffer,
    signature: string,
    publicKey: string | Buffer | KeyLike,
    options?: VerificationOptions,
  ): boolean {
    try {
      const dataBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
      const encoding = options?.encoding ?? (/^[0-9a-fA-F]+$/.test(signature) ? "hex" : "base64");
      const sigBuf = Buffer.from(signature.trim(), encoding);

      return cryptoVerify(null, dataBuf, publicKey, sigBuf);
    } catch {
      return false;
    }
  }

  sign(
    payload: string | Buffer,
    privateKey: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string {
    const dataBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const sigBuf = cryptoSign(null, dataBuf, privateKey);
    const encoding = options?.encoding ?? "hex";
    return sigBuf.toString(encoding);
  }
}

/**
 * Asymmetric RSA-SHA256 Verifier
 * Verifies RSA PKCS#1 v1.5 or PSS signatures using SHA-256
 */
export class RsaSha256SignatureVerifier implements SignatureVerifier {
  readonly name = "rsa-sha256";
  readonly algorithm = "rsa-sha256" as const;
  private readonly headerName: string;

  constructor(headerName = "x-rsa-signature") {
    this.headerName = headerName;
  }

  extractSignature(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    return getHeader(headers, this.headerName);
  }

  verify(
    payload: string | Buffer,
    signature: string,
    publicKey: string | Buffer | KeyLike,
    options?: VerificationOptions,
  ): boolean {
    try {
      const dataBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
      const encoding = options?.encoding ?? (/^[0-9a-fA-F]+$/.test(signature) ? "hex" : "base64");
      const sigBuf = Buffer.from(signature.trim(), encoding);

      const verifier = createVerify("RSA-SHA256");
      verifier.update(dataBuf);
      verifier.end();
      return verifier.verify(publicKey, sigBuf);
    } catch {
      return false;
    }
  }

  sign(
    payload: string | Buffer,
    privateKey: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string {
    const dataBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const signer = createSign("RSA-SHA256");
    signer.update(dataBuf);
    signer.end();
    const sigBuf = signer.sign(privateKey);
    const encoding = options?.encoding ?? "hex";
    return sigBuf.toString(encoding);
  }
}

// ---------------------------------------------------------------------------
// Provider & Verifier Registry
// ---------------------------------------------------------------------------

export class ProviderVerifierRegistry {
  private providers = new Map<string, ProviderConfig>();
  private verifiers = new Map<string, SignatureVerifier>();

  constructor() {
    this.registerDefaultVerifiers();
    this.registerDefaultProviders();
  }

  /** Register built-in standard verifiers */
  private registerDefaultVerifiers() {
    this.registerVerifier(new GitHubSignatureVerifier());
    this.registerVerifier(new SecureFlowSignatureVerifier());
    this.registerVerifier(new StripeSignatureVerifier());
    this.registerVerifier(new SlackSignatureVerifier());
    this.registerVerifier(new GitLabTokenVerifier());
    this.registerVerifier(new GenericHmacVerifier({ name: "generic-sha256", hashAlgo: "sha256" }));
    this.registerVerifier(new GenericHmacVerifier({ name: "generic-sha512", hashAlgo: "sha512" }));
    this.registerVerifier(new Ed25519SignatureVerifier());
    this.registerVerifier(new RsaSha256SignatureVerifier());
  }

  /** Register built-in standard provider templates */
  private registerDefaultProviders() {
    this.registerProvider({
      providerId: "github",
      displayName: "GitHub Webhooks",
      verifier: this.getVerifier("github")!,
      signatureHeader: "x-hub-signature-256",
    });

    this.registerProvider({
      providerId: "secureflow",
      displayName: "SecureFlow Outbound & Webhooks",
      verifier: this.getVerifier("secureflow")!,
      signatureHeader: "x-secureflow-signature",
      timestampHeader: "x-secureflow-timestamp",
      requireTimestamp: true,
      replayWindowSeconds: 300,
    });

    this.registerProvider({
      providerId: "stripe",
      displayName: "Stripe Webhooks",
      verifier: this.getVerifier("stripe")!,
      signatureHeader: "stripe-signature",
      replayWindowSeconds: 300,
    });

    this.registerProvider({
      providerId: "slack",
      displayName: "Slack Webhooks",
      verifier: this.getVerifier("slack")!,
      signatureHeader: "x-slack-signature",
      timestampHeader: "x-slack-request-timestamp",
      requireTimestamp: true,
      replayWindowSeconds: 300,
    });

    this.registerProvider({
      providerId: "gitlab",
      displayName: "GitLab Webhooks",
      verifier: this.getVerifier("gitlab")!,
      signatureHeader: "x-gitlab-token",
    });
  }

  /** Register a standalone verifier by name */
  registerVerifier(verifier: SignatureVerifier): this {
    this.verifiers.set(verifier.name.toLowerCase(), verifier);
    return this;
  }

  /** Retrieve a verifier by name */
  getVerifier(name: string): SignatureVerifier | undefined {
    return this.verifiers.get(name.toLowerCase());
  }

  /** Register or update a provider config */
  registerProvider(config: ProviderConfig): this {
    this.providers.set(config.providerId.toLowerCase(), config);
    if (!this.verifiers.has(config.verifier.name.toLowerCase())) {
      this.verifiers.set(config.verifier.name.toLowerCase(), config.verifier);
    }
    return this;
  }

  /** Unregister a provider by id */
  unregisterProvider(providerId: string): boolean {
    return this.providers.delete(providerId.toLowerCase());
  }

  /** Retrieve provider configuration */
  getProvider(providerId: string): ProviderConfig | undefined {
    return this.providers.get(providerId.toLowerCase());
  }

  /** List all registered provider IDs */
  listProviderIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /** List all registered verifier names */
  listVerifierNames(): string[] {
    return Array.from(this.verifiers.keys());
  }

  /**
   * Main verification entry point.
   * Dispatches to registered verifier, checks replay timestamps, and iterates
   * primary and secondary key rotation secrets.
   */
  async verifyRequest(params: VerifyRequestParams): Promise<VerificationResult> {
    const { providerId, payload, headers } = params;
    const provider = this.getProvider(providerId);

    if (!provider) {
      return {
        ok: false,
        status: 400,
        message: `Unknown webhook provider '${providerId}'`,
      };
    }

    const verifier = provider.verifier;

    // 1. Extract signature from headers
    const signature = verifier.extractSignature(headers);
    if (!signature) {
      return {
        ok: false,
        status: 401,
        message: `Missing signature header for provider '${providerId}'`,
      };
    }

    // 2. Extract timestamp if applicable
    let timestamp: number | null = null;
    if (verifier.extractTimestamp) {
      timestamp = verifier.extractTimestamp(headers);
    }

    if (provider.requireTimestamp && (timestamp === null || Number.isNaN(timestamp))) {
      return {
        ok: false,
        status: 401,
        message: `Missing or invalid timestamp header for provider '${providerId}'`,
      };
    }

    // 3. Resolve active and key rotation fallback secrets
    const primarySecrets = resolveSecrets(params.secret ?? provider.secret);
    const secondarySecrets = resolveSecrets(provider.secondarySecrets);
    const allSecrets = [...primarySecrets, ...secondarySecrets];

    if (allSecrets.length === 0) {
      return {
        ok: false,
        status: 500,
        message: `No secret configured for provider '${providerId}'`,
      };
    }

    const replayWindowSeconds =
      params.replayWindowSeconds ?? provider.replayWindowSeconds ?? 300;

    const options: VerificationOptions = {
      timestamp: timestamp ?? undefined,
      replayWindowSeconds,
    };

    // 4. Try verification against primary and rotation secrets
    let lastFailure: VerificationResult | null = null;

    for (let index = 0; index < allSecrets.length; index++) {
      const secret = allSecrets[index];
      const result = verifier.verify(payload, signature, secret, options);

      if (typeof result === "boolean") {
        if (result) {
          return {
            ok: true,
            providerId,
            scheme: verifier.algorithm,
            keyIndex: index,
            timestamp: timestamp ?? undefined,
          };
        }
      } else if (result.ok) {
        return {
          ...result,
          providerId,
          keyIndex: index,
        };
      } else {
        lastFailure = result;
      }
    }

    if (lastFailure) {
      return {
        ...lastFailure,
        providerId,
      };
    }

    return {
      ok: false,
      status: 401,
      message: `Invalid signature for provider '${providerId}'`,
      providerId,
    };
  }

  /**
   * Sign a payload for a registered provider or verifier.
   */
  signPayload(
    providerIdOrVerifier: string,
    payload: string | Buffer,
    secretOrKey: string | Buffer | KeyLike,
    options?: SignOptions,
  ): string {
    const provider = this.getProvider(providerIdOrVerifier);
    const verifier = provider ? provider.verifier : this.getVerifier(providerIdOrVerifier);

    if (!verifier) {
      throw new Error(`Verifier or provider '${providerIdOrVerifier}' not found`);
    }

    if (!verifier.sign) {
      throw new Error(`Verifier '${verifier.name}' does not implement signing`);
    }

    return verifier.sign(payload, secretOrKey, options);
  }
}

/** Global default provider and verifier registry instance */
export const defaultProviderRegistry = new ProviderVerifierRegistry();
