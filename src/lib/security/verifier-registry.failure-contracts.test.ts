import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Ed25519SignatureVerifier,
  GenericHmacVerifier,
  GitHubSignatureVerifier,
  GitLabTokenVerifier,
  ProviderVerifierRegistry,
  RsaSha256SignatureVerifier,
  SecureFlowSignatureVerifier,
  SlackSignatureVerifier,
  StripeSignatureVerifier,
  getHeader,
} from "./verifier-registry";

const payload = Buffer.from('{"event":"synthetic-fixture"}');
const secret = "synthetic-verifier-fixture";
const timestamp = 1_800_000_000;
const digest = (text: string) => createHmac("sha256", secret).update(text).digest("hex");

afterEach(() => vi.restoreAllMocks());

describe("provider authentication rejection contracts", () => {
  it("handles repeated/empty headers without turning absent values into credentials", () => {
    expect(getHeader({ "X-Signature": [] }, "x-signature")).toBeNull();
    expect(getHeader({ "X-Signature": undefined }, "x-signature")).toBeNull();
    expect(getHeader({ "X-Signature": ["first", "second"] }, "x-signature")).toBe("first");
  });

  it("checks GitHub Buffer payloads against an independently computed digest", () => {
    const verifier = new GitHubSignatureVerifier();
    const signature = digest(payload.toString());
    expect(verifier.extractSignature({ "X-Hub-Signature-256": signature })).toBe(signature);
    expect(verifier.verify(payload, signature, secret)).toBe(true);
    expect(verifier.sign(payload, secret)).toBe(`sha256=${signature}`);
    expect(verifier.verify(payload, "sha256=bad", secret)).toBe(false);
    expect(verifier.verify(payload, "g".repeat(64), secret)).toBe(false);
    expect(verifier.verify(payload, signature, "")).toBe(false);
    expect(verifier.verify(payload, signature, Buffer.from(secret))).toBe(false);
    expect(() => verifier.sign(payload, Buffer.from(secret))).toThrow();
  });

  it("rejects malformed, modified and conflicting SecureFlow signatures", () => {
    vi.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
    const verifier = new SecureFlowSignatureVerifier();
    const signature = `t=${timestamp},v1=${digest(`${timestamp}.${payload}`)}`;
    expect(verifier.sign(payload, secret)).toBe(signature);
    expect(verifier.verify(payload, `ignored,${signature},t=1`, secret)).toMatchObject({
      ok: true,
    });
    expect(verifier.verify(payload, signature, secret, { timestamp: timestamp + 2 })).toMatchObject(
      { ok: false, status: 401 },
    );
    for (const bad of [
      "sha256=bad",
      `sha256=${"0".repeat(64)}`,
      "t=oops,v1=bad",
      `t=${timestamp},v1=${"0".repeat(64)}`,
    ]) {
      expect(verifier.verify(payload, bad, secret)).toMatchObject({ ok: false, status: 401 });
    }
    expect(verifier.verify(payload, signature, "")).toMatchObject({ ok: false, status: 500 });
    expect(() => verifier.sign(payload, Buffer.from(secret))).toThrow();
    expect(verifier.extractTimestamp({})).toBeNull();
    expect(verifier.extractTimestamp({ "x-secureflow-timestamp": "not-a-time" })).toBeNull();
  });

  it("accepts a rotated Stripe signature and rejects missing, malformed or unmatched authentication", () => {
    vi.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
    const verifier = new StripeSignatureVerifier();
    const signature = verifier.sign(payload, secret);
    expect(signature).toBe(`t=${timestamp},v1=${digest(`${timestamp}.${payload}`)}`);
    expect(
      verifier.verify(
        payload,
        `ignored,t=${timestamp},v0=old,v1=${"0".repeat(64)},${signature.split(",")[1]}`,
        secret,
      ),
    ).toMatchObject({ ok: true });
    for (const bad of [
      "v1=bad",
      "t=NaN,v1=bad",
      `t=${timestamp}`,
      `t=${timestamp},v1=${"0".repeat(64)}`,
    ]) {
      expect(verifier.verify(payload, bad, secret)).toMatchObject({ ok: false, status: 401 });
    }
    expect(verifier.verify(payload, signature, "")).toMatchObject({ ok: false, status: 500 });
    expect(verifier.extractTimestamp({})).toBeNull();
    expect(verifier.extractTimestamp({ "stripe-signature": "v1=bad" })).toBeNull();
    expect(() => verifier.sign(payload, Buffer.from(secret))).toThrow();
  });

  it("requires Slack timestamps, enforces expiry, and rejects malformed or modified signatures", () => {
    vi.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
    const verifier = new SlackSignatureVerifier();
    const signature = `v0=${digest(`v0:${timestamp}:${payload}`)}`;
    expect(verifier.sign(payload, secret)).toBe(signature);
    expect(verifier.verify(payload, signature, secret, { timestamp })).toMatchObject({ ok: true });
    expect(verifier.verify(payload, signature.slice(3), secret, { timestamp })).toMatchObject({
      ok: true,
    });
    expect(verifier.verify(payload, signature, "", { timestamp })).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(verifier.verify(payload, signature, secret)).toMatchObject({ ok: false, status: 401 });
    expect(
      verifier.verify(payload, signature, secret, { timestamp: timestamp - 301 }),
    ).toMatchObject({ ok: false, status: 401 });
    for (const bad of ["v0=bad", `v0=${"g".repeat(64)}`, `v0=${"0".repeat(64)}`]) {
      expect(verifier.verify(payload, bad, secret, { timestamp })).toMatchObject({
        ok: false,
        status: 401,
      });
    }
    expect(verifier.extractTimestamp({})).toBeNull();
    expect(verifier.extractTimestamp({ "x-slack-request-timestamp": "not-a-time" })).toBeNull();
    expect(() => verifier.sign(payload, Buffer.from(secret))).toThrow();
  });

  it("refuses missing GitLab and generic HMAC secrets", () => {
    const token = new GitLabTokenVerifier();
    expect(token.verify(payload, secret, "")).toBe(false);
    expect(token.verify(payload, secret, Buffer.from(secret))).toBe(false);
    const hmac = new GenericHmacVerifier();
    expect(hmac.verify(payload, digest(payload.toString()), secret)).toBe(true);
    expect(hmac.verify(payload, digest(payload.toString()), "")).toBe(false);
    expect(hmac.verify(payload, digest(payload.toString()), Buffer.from(secret))).toBe(false);
    expect(() => hmac.sign(payload, Buffer.from(secret))).toThrow();
    expect(hmac.extractSignature({})).toBeNull();
    expect(hmac.sign(payload, secret)).toBe(digest(payload.toString()));
  });

  it("supports custom key headers and standalone signing, while refusing unsupported signers", () => {
    const rsa = new RsaSha256SignatureVerifier("X-Custom-RSA");
    const ed = new Ed25519SignatureVerifier("X-Custom-Ed");
    expect(rsa.extractSignature({ "x-custom-rsa": "synthetic-signature" })).toBe(
      "synthetic-signature",
    );
    expect(ed.extractSignature({ "x-custom-ed": "synthetic-signature" })).toBe(
      "synthetic-signature",
    );
    const registry = new ProviderVerifierRegistry();
    expect(registry.signPayload("generic-sha256", payload, secret)).toBe(
      digest(payload.toString()),
    );
    expect(() => registry.signPayload("missing-provider", payload, secret)).toThrow(/not found/);
    expect(() => registry.signPayload("gitlab", payload, secret)).toThrow(
      /does not implement signing/,
    );
  });

  it("resolves provider-configured rotation secrets and reports the matching key", async () => {
    const verifier = new GenericHmacVerifier();
    const registry = new ProviderVerifierRegistry();
    registry.registerProvider({
      providerId: "fixture-rotation",
      verifier,
      secret: () => "old-fixture-key",
      secondarySecrets: [() => secret],
    });
    const result = await registry.verifyRequest({
      providerId: "fixture-rotation",
      payload,
      headers: { "x-signature": digest(payload.toString()) },
    });
    expect(result).toMatchObject({ ok: true, providerId: "fixture-rotation", keyIndex: 1 });
  });

  it.each(["ed25519", "rsa"] as const)(
    "checks %s Buffer/base64 signatures and fails closed on invalid keys",
    (algorithm) => {
      const keys =
        algorithm === "ed25519"
          ? generateKeyPairSync("ed25519")
          : generateKeyPairSync("rsa", { modulusLength: 2048 });
      const verifier =
        algorithm === "ed25519" ? new Ed25519SignatureVerifier() : new RsaSha256SignatureVerifier();
      const signature = sign(
        algorithm === "ed25519" ? null : "RSA-SHA256",
        payload,
        keys.privateKey,
      ).toString("base64");
      expect(verifier.verify(payload, signature, keys.publicKey)).toBe(true);
      expect(verifier.verify(payload, signature, keys.publicKey, { encoding: "base64" })).toBe(
        true,
      );
      expect(verifier.verify(payload, signature, "invalid-key-fixture")).toBe(false);
      expect(verifier.verify(Buffer.from("modified"), signature, keys.publicKey)).toBe(false);
      expect(verifier.sign(payload, keys.privateKey, { encoding: "base64" })).toBe(signature);
    },
  );
});
