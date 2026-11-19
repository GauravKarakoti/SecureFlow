import { describe, it, expect } from "vitest";
import {
  generateOutboundWebhookSecret,
  computeOutboundWebhookSignature,
  verifyOutboundWebhookSignature,
} from "./outbound-signature";

describe("Outbound Webhook Signature & Replay Protection (#1866)", () => {
  const secret = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const payload = JSON.stringify({
    id: "evt_12345",
    event: "scan.completed",
    timestamp: "2026-11-19T18:00:00.000Z",
    data: { repository: "acme/repo", decision: "PASS" },
  });

  describe("generateOutboundWebhookSecret", () => {
    it("generates a secure 64-char hex secret prefixed with whsec_", () => {
      const s1 = generateOutboundWebhookSecret();
      const s2 = generateOutboundWebhookSecret();

      expect(s1).toMatch(/^whsec_[0-9a-f]{64}$/);
      expect(s2).toMatch(/^whsec_[0-9a-f]{64}$/);
      expect(s1).not.toBe(s2);
    });
  });

  describe("computeOutboundWebhookSignature", () => {
    it("computes deterministic HMAC-SHA256 signature in sha256=<hex> format", () => {
      const sig1 = computeOutboundWebhookSignature(payload, secret);
      const sig2 = computeOutboundWebhookSignature(payload, secret);

      expect(sig1).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(sig1).toBe(sig2);
    });

    it("changes when payload or secret changes", () => {
      const sig1 = computeOutboundWebhookSignature(payload, secret);
      const sig2 = computeOutboundWebhookSignature(payload + " ", secret);
      const sig3 = computeOutboundWebhookSignature(payload, secret + "x");

      expect(sig1).not.toBe(sig2);
      expect(sig1).not.toBe(sig3);
    });
  });

  describe("verifyOutboundWebhookSignature", () => {
    it("verifies a valid signature", () => {
      const sig = computeOutboundWebhookSignature(payload, secret);
      const res = verifyOutboundWebhookSignature({ payload, signature: sig, secret });

      expect(res.valid).toBe(true);
      expect(res.reason).toBeUndefined();
    });

    it("rejects tampered payloads", () => {
      const sig = computeOutboundWebhookSignature(payload, secret);
      const tampered = payload.replace("PASS", "BLOCKED");
      const res = verifyOutboundWebhookSignature({ payload: tampered, signature: sig, secret });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("Signature mismatch.");
    });

    it("rejects wrong secret", () => {
      const sig = computeOutboundWebhookSignature(payload, secret);
      const res = verifyOutboundWebhookSignature({
        payload,
        signature: sig,
        secret: "whsec_wrongsecret",
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe("Signature mismatch.");
    });

    it("enforces replay tolerance window on timestamp", () => {
      const sig = computeOutboundWebhookSignature(payload, secret);
      const now = Date.now();
      const freshTime = new Date(now - 30 * 1000).toISOString(); // 30s ago
      const expiredTime = new Date(now - 400 * 1000).toISOString(); // 400s ago

      const freshRes = verifyOutboundWebhookSignature({
        payload,
        signature: sig,
        secret,
        timestamp: freshTime,
        toleranceSeconds: 300,
      });
      expect(freshRes.valid).toBe(true);

      const expiredRes = verifyOutboundWebhookSignature({
        payload,
        signature: sig,
        secret,
        timestamp: expiredTime,
        toleranceSeconds: 300,
      });
      expect(expiredRes.valid).toBe(false);
      expect(expiredRes.reason).toContain("Timestamp outside tolerance window");
    });
  });
});
