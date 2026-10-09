import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync } from "crypto";
import {
  ProviderVerifierRegistry,
  GitHubSignatureVerifier,
  SecureFlowSignatureVerifier,
  GenericHmacVerifier,
  Ed25519SignatureVerifier,
  RsaSha256SignatureVerifier,
  safeHexCompare,
  safeStringCompare,
  resolveSecrets,
  getHeader,
} from "./verifier-registry";

describe("ProviderVerifierRegistry", () => {
  let registry: ProviderVerifierRegistry;

  beforeEach(() => {
    registry = new ProviderVerifierRegistry();
  });

  describe("Built-in Providers & Verifiers Registration", () => {
    it("initializes with standard providers and verifiers", () => {
      const providerIds = registry.listProviderIds();
      expect(providerIds).toContain("github");
      expect(providerIds).toContain("secureflow");
      expect(providerIds).toContain("stripe");
      expect(providerIds).toContain("slack");
      expect(providerIds).toContain("gitlab");

      const verifierNames = registry.listVerifierNames();
      expect(verifierNames).toContain("github");
      expect(verifierNames).toContain("secureflow");
      expect(verifierNames).toContain("stripe");
      expect(verifierNames).toContain("slack");
      expect(verifierNames).toContain("gitlab");
      expect(verifierNames).toContain("generic-sha256");
      expect(verifierNames).toContain("generic-sha512");
      expect(verifierNames).toContain("ed25519");
      expect(verifierNames).toContain("rsa-sha256");
    });

    it("allows registering and unregistering custom providers", () => {
      const customVerifier = new GenericHmacVerifier({
        name: "custom-auth",
        headerName: "X-Auth-Sig",
        prefix: "sig-",
      });

      registry.registerProvider({
        providerId: "custom-service",
        displayName: "Custom Service",
        verifier: customVerifier,
        secret: "my-custom-secret",
      });

      expect(registry.getProvider("custom-service")).toBeDefined();
      expect(registry.listProviderIds()).toContain("custom-service");

      const removed = registry.unregisterProvider("custom-service");
      expect(removed).toBe(true);
      expect(registry.getProvider("custom-service")).toBeUndefined();
    });
  });

  describe("GitHub Signature Verifier", () => {
    const secret = "github-webhook-secret";
    const payload = JSON.stringify({ action: "opened", number: 42 });

    it("verifies valid GitHub signatures", async () => {
      const verifier = new GitHubSignatureVerifier();
      const sig = verifier.sign(payload, secret);
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

      const res = await registry.verifyRequest({
        providerId: "github",
        payload,
        secret,
        headers: { "x-hub-signature-256": sig },
      });

      expect(res.ok).toBe(true);
      expect(res.providerId).toBe("github");
    });

    it("rejects invalid or tampered GitHub signatures", async () => {
      const res = await registry.verifyRequest({
        providerId: "github",
        payload,
        secret,
        headers: { "x-hub-signature-256": "sha256=" + "f".repeat(64) },
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
    });

    it("rejects missing signature header", async () => {
      const res = await registry.verifyRequest({
        providerId: "github",
        payload,
        secret,
        headers: {},
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.message).toContain("Missing signature header");
    });
  });

  describe("SecureFlow Signature Verifier", () => {
    const secret = "sf-shared-secret";
    const payload = JSON.stringify({ event: "finding.detected", count: 3 });

    it("verifies canonical v1 signature and enforces timestamp agreement", async () => {
      const verifier = new SecureFlowSignatureVerifier();
      const now = Math.floor(Date.now() / 1000);
      const sig = verifier.sign(payload, secret, { timestamp: now });

      const res = await registry.verifyRequest({
        providerId: "secureflow",
        payload,
        secret,
        headers: {
          "x-secureflow-signature": sig,
          "x-secureflow-timestamp": String(now),
        },
      });

      expect(res.ok).toBe(true);
      expect(res.scheme).toBe("v1");
      expect(res.timestamp).toBe(now);
    });

    it("rejects timestamp outside replay window", async () => {
      const verifier = new SecureFlowSignatureVerifier();
      const oldTime = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const sig = verifier.sign(payload, secret, { timestamp: oldTime });

      const res = await registry.verifyRequest({
        providerId: "secureflow",
        payload,
        secret,
        replayWindowSeconds: 300,
        headers: {
          "x-secureflow-signature": sig,
          "x-secureflow-timestamp": String(oldTime),
        },
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.message).toContain("outside allowed window");
    });

    it("rejects timestamp mismatch between header and signature", async () => {
      const verifier = new SecureFlowSignatureVerifier();
      const now = Math.floor(Date.now() / 1000);
      const sig = verifier.sign(payload, secret, { timestamp: now });

      const res = await registry.verifyRequest({
        providerId: "secureflow",
        payload,
        secret,
        headers: {
          "x-secureflow-signature": sig,
          "x-secureflow-timestamp": String(now + 10), // forged header timestamp
        },
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.message).toContain("does not match timestamp header");
    });

    it("verifies legacy sha256= signatures", async () => {
      const digest = new GenericHmacVerifier().sign(payload, secret);
      const res = await registry.verifyRequest({
        providerId: "secureflow",
        payload,
        secret,
        headers: {
          "x-secureflow-signature": `sha256=${digest}`,
          "x-secureflow-timestamp": String(Math.floor(Date.now() / 1000)),
        },
      });

      expect(res.ok).toBe(true);
      expect(res.scheme).toBe("legacy");
    });
  });

  describe("Stripe Signature Verifier", () => {
    const secret = "whsec_test_stripe_123";
    const payload = JSON.stringify({ type: "payment_intent.succeeded" });

    it("verifies valid Stripe signatures with timestamp", async () => {
      const now = Math.floor(Date.now() / 1000);
      const sig = registry.signPayload("stripe", payload, secret, { timestamp: now });

      const res = await registry.verifyRequest({
        providerId: "stripe",
        payload,
        secret,
        headers: { "stripe-signature": sig },
      });

      expect(res.ok).toBe(true);
      expect(res.scheme).toBe("stripe-v1");
      expect(res.timestamp).toBe(now);
    });

    it("rejects expired Stripe webhook signature", async () => {
      const oldTime = Math.floor(Date.now() / 1000) - 500;
      const sig = registry.signPayload("stripe", payload, secret, { timestamp: oldTime });

      const res = await registry.verifyRequest({
        providerId: "stripe",
        payload,
        secret,
        replayWindowSeconds: 300,
        headers: { "stripe-signature": sig },
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(res.message).toContain("expired");
    });
  });

  describe("Slack Signature Verifier", () => {
    const secret = "slack_signing_secret_xyz";
    const payload = "command=/scan&text=repo";

    it("verifies valid Slack signatures", async () => {
      const now = Math.floor(Date.now() / 1000);
      const sig = registry.signPayload("slack", payload, secret, { timestamp: now });

      const res = await registry.verifyRequest({
        providerId: "slack",
        payload,
        secret,
        headers: {
          "x-slack-signature": sig,
          "x-slack-request-timestamp": String(now),
        },
      });

      expect(res.ok).toBe(true);
      expect(res.scheme).toBe("slack-v0");
    });
  });

  describe("GitLab Token Verifier", () => {
    const token = "secret-gitlab-webhook-token";
    const payload = JSON.stringify({ object_kind: "push" });

    it("verifies valid GitLab token", async () => {
      const res = await registry.verifyRequest({
        providerId: "gitlab",
        payload,
        secret: token,
        headers: { "x-gitlab-token": token },
      });

      expect(res.ok).toBe(true);
      expect(res.scheme).toBe("token-match");
    });

    it("rejects invalid GitLab token", async () => {
      const res = await registry.verifyRequest({
        providerId: "gitlab",
        payload,
        secret: token,
        headers: { "x-gitlab-token": "wrong-token" },
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
    });
  });

  describe("Asymmetric Signature Verification (Ed25519 & RSA-SHA256)", () => {
    it("signs and verifies Ed25519 payload", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const edVerifier = new Ed25519SignatureVerifier();
      const payload = "secureflow:ed25519:test:data";

      const signature = edVerifier.sign(payload, privateKey);
      expect(signature).toBeDefined();

      const valid = edVerifier.verify(payload, signature, publicKey);
      expect(valid).toBe(true);

      const invalid = edVerifier.verify(payload + "-tampered", signature, publicKey);
      expect(invalid).toBe(false);
    });

    it("signs and verifies RSA-SHA256 payload", () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const rsaVerifier = new RsaSha256SignatureVerifier();
      const payload = "secureflow:rsa:audit:manifest";

      const signature = rsaVerifier.sign(payload, privateKey);
      expect(signature).toBeDefined();

      const valid = rsaVerifier.verify(payload, signature, publicKey);
      expect(valid).toBe(true);

      const invalid = rsaVerifier.verify(payload, signature + "aa", publicKey);
      expect(invalid).toBe(false);
    });
  });

  describe("Key Rotation Support", () => {
    it("falls back to secondary rotation key when primary fails", async () => {
      const activeKey = "new-active-key";
      const oldRotationKey = "previous-key-under-rotation";
      const payload = JSON.stringify({ audit: "key-rotation-test" });

      registry.registerProvider({
        providerId: "rotation-test",
        verifier: new GitHubSignatureVerifier(),
        secret: activeKey,
        secondarySecrets: [oldRotationKey],
      });

      // Sign payload with the OLD rotation key
      const oldSig = registry.signPayload("github", payload, oldRotationKey);

      const res = await registry.verifyRequest({
        providerId: "rotation-test",
        payload,
        headers: { "x-hub-signature-256": oldSig },
      });

      expect(res.ok).toBe(true);
      expect(res.keyIndex).toBe(1); // Second key in rotation chain matched!
    });
  });

  describe("Edge cases & Error Handling", () => {
    it("returns 400 for unknown provider", async () => {
      const res = await registry.verifyRequest({
        providerId: "nonexistent-provider",
        payload: "{}",
        headers: {},
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
    });

    it("returns 500 when no secret is configured for provider", async () => {
      const res = await registry.verifyRequest({
        providerId: "github",
        payload: "{}",
        headers: { "x-hub-signature-256": "sha256=" + "a".repeat(64) },
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
      expect(res.message).toContain("No secret configured");
    });

    it("safeHexCompare safely checks equality and rejects malformed hex", () => {
      expect(safeHexCompare("aabbcc", "aabbcc")).toBe(true);
      expect(safeHexCompare("AABBCC", "aabbcc")).toBe(true);
      expect(safeHexCompare("aabbcc", "aabbcd")).toBe(false);
      expect(safeHexCompare("aabbcc", "aabb")).toBe(false);
      expect(safeHexCompare("not-hex", "not-hex")).toBe(false);
    });

    it("safeStringCompare correctly handles equal and unequal lengths", () => {
      expect(safeStringCompare("hello", "hello")).toBe(true);
      expect(safeStringCompare("hello", "world")).toBe(false);
      expect(safeStringCompare("hello", "hello world")).toBe(false);
    });

    it("resolveSecrets extracts strings from functions and filters empty values", () => {
      const secrets = resolveSecrets([
        "key1",
        () => "key2",
        () => undefined,
        "   ",
        () => " key3 ",
      ]);
      expect(secrets).toEqual(["key1", "key2", "key3"]);
    });

    it("getHeader extracts case-insensitively from Headers and objects", () => {
      const headers = new Headers();
      headers.set("X-Custom-Header", "value1");
      expect(getHeader(headers, "x-custom-header")).toBe("value1");

      const plainObj = { "X-ANOTHER-HEADER": ["value2"] };
      expect(getHeader(plainObj, "x-another-header")).toBe("value2");
    });
  });
});
