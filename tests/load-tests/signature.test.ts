import { describe, expect, it } from "vitest";
import { computeHmacSignature } from "../../load-tests/helpers/signature.js";
import {
  parseGithubSignature,
  verifySignature,
} from "@/lib/github/webhook-verification";

describe("load-tests/helpers/signature.js (HMAC Signature Helper)", () => {
  const secret = "test-webhook-secret-load-testing-only";
  const samplePayload = JSON.stringify({
    action: "opened",
    number: 42,
    repository: { full_name: "loadtest-org/sample-repo" },
  });

  it("computes a valid sha256= prefixed hex digest", () => {
    const signature = computeHmacSignature(samplePayload, secret);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("produces a signature accepted by SecureFlow webhook verification", () => {
    const signatureHeader = computeHmacSignature(samplePayload, secret);
    const parsedHex = parseGithubSignature(signatureHeader);
    expect(parsedHex).not.toBeNull();

    const isValid = verifySignature(samplePayload, secret, parsedHex!);
    expect(isValid).toBe(true);
  });

  it("rejects tampered payloads", () => {
    const signatureHeader = computeHmacSignature(samplePayload, secret);
    const parsedHex = parseGithubSignature(signatureHeader);

    const tamperedPayload = JSON.stringify({
      action: "opened",
      number: 43, // Changed
      repository: { full_name: "loadtest-org/sample-repo" },
    });

    const isValid = verifySignature(tamperedPayload, secret, parsedHex!);
    expect(isValid).toBe(false);
  });

  it("rejects incorrect secrets", () => {
    const signatureHeader = computeHmacSignature(samplePayload, "wrong-secret");
    const parsedHex = parseGithubSignature(signatureHeader);

    const isValid = verifySignature(samplePayload, secret, parsedHex!);
    expect(isValid).toBe(false);
  });

  it("supports objects by automatically stringifying them", () => {
    const payloadObj = { action: "opened", number: 100 };
    const signatureHeader = computeHmacSignature(payloadObj, secret);
    const parsedHex = parseGithubSignature(signatureHeader);

    const isValid = verifySignature(JSON.stringify(payloadObj), secret, parsedHex!);
    expect(isValid).toBe(true);
  });

  it("throws an error if secret is missing", () => {
    expect(() => computeHmacSignature(samplePayload, "")).toThrow(
      /Webhook secret is required/,
    );
  });
});
