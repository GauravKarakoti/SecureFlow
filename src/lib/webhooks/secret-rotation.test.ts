import { describe, it, expect } from "vitest";
import {
  createRotationTransition,
  isGraceWindowActive,
  buildDualSignatureHeaders,
  verifyWithRotationGrace,
  computeHmacSha256Header,
  OUTBOUND_KEY_ID_HEADER,
  OUTBOUND_PREVIOUS_SIGNATURE_HEADER,
} from "./secret-rotation";
import { verifyOutboundWebhookSignature } from "./outbound-signature";
import { signPayloadV1, admitWebhookRequestWithRotation } from "@/lib/security/hmacSigner";

describe("Zero-Downtime Dual-Key HMAC Secret Rotation (#2109)", () => {
  const payload = JSON.stringify({ event: "scan.completed", scanId: "scan_123" });

  it("creates a rotation transition with fresh primary secret and grace window", () => {
    const t0 = 1_700_000_000_000;
    const rotated = createRotationTransition("whsec_old_secret", "kid_old", 60_000, t0);

    expect(rotated.primarySecret).toMatch(/^whsec_[a-f0-9]{64}$/);
    expect(rotated.primarySecret).not.toBe("whsec_old_secret");
    expect(rotated.primaryKeyId).toMatch(/^kid_[a-f0-9]{12}$/);
    expect(rotated.previousSecret).toBe("whsec_old_secret");
    expect(rotated.previousKeyId).toBe("kid_old");
    expect(isGraceWindowActive(rotated, t0)).toBe(true);
    expect(isGraceWindowActive(rotated, t0 + 60_000)).toBe(true);
    expect(isGraceWindowActive(rotated, t0 + 60_001)).toBe(false);
  });

  it("emits dual signature headers only while rotation grace window is active", () => {
    const t0 = 1_700_000_000_000;
    const config = createRotationTransition("whsec_prev", "kid_prev", 30_000, t0);

    const duringGrace = buildDualSignatureHeaders(payload, config, t0 + 5_000);
    expect(duringGrace["X-SecureFlow-Signature"]).toBe(
      computeHmacSha256Header(payload, config.primarySecret),
    );
    expect(duringGrace[OUTBOUND_KEY_ID_HEADER]).toBe(config.primaryKeyId);
    expect(duringGrace[OUTBOUND_PREVIOUS_SIGNATURE_HEADER]).toBe(
      computeHmacSha256Header(payload, "whsec_prev"),
    );

    const afterGrace = buildDualSignatureHeaders(payload, config, t0 + 35_000);
    expect(afterGrace["X-SecureFlow-Signature"]).toBeDefined();
    expect(afterGrace[OUTBOUND_PREVIOUS_SIGNATURE_HEADER]).toBeUndefined();
  });

  it("accepts primary and grace-window previous signatures, and rejects expired previous signatures", () => {
    const t0 = 1_700_000_000_000;
    const config = createRotationTransition("whsec_old_1", "kid_old_1", 10_000, t0);

    const primarySig = computeHmacSha256Header(payload, config.primarySecret);
    const oldSig = computeHmacSha256Header(payload, "whsec_old_1");
    const invalidSig = computeHmacSha256Header(payload, "whsec_attacker");

    const resPrimary = verifyWithRotationGrace(payload, primarySig, config, t0 + 5_000);
    expect(resPrimary.valid).toBe(true);
    expect(resPrimary.matchedKey).toBe("primary");
    expect(resPrimary.graceExpired).toBe(false);

    const resOldActive = verifyWithRotationGrace(payload, oldSig, config, t0 + 5_000);
    expect(resOldActive.valid).toBe(true);
    expect(resOldActive.matchedKey).toBe("previous");
    expect(resOldActive.matchedKeyId).toBe("kid_old_1");

    const resOldExpired = verifyWithRotationGrace(payload, oldSig, config, t0 + 15_000);
    expect(resOldExpired.valid).toBe(false);
    expect(resOldExpired.matchedKey).toBe("none");
    expect(resOldExpired.graceExpired).toBe(true);

    const resInvalid = verifyWithRotationGrace(payload, invalidSig, config, t0 + 5_000);
    expect(resInvalid.valid).toBe(false);
    expect(resInvalid.graceExpired).toBe(false);

    const resShort = verifyWithRotationGrace(payload, "sha256=short", config, t0 + 5_000);
    expect(resShort.valid).toBe(false);
  });

  it("integrates with verifyOutboundWebhookSignature in outbound-signature.ts", () => {
    const oldSecret = "whsec_legacy_key";
    const newSecret = "whsec_rotated_key";
    const oldSig = computeHmacSha256Header(payload, oldSecret);

    const res = verifyOutboundWebhookSignature({
      payload,
      signature: oldSig,
      secret: newSecret,
      previousSecret: oldSecret,
      rotationGraceUntil: Date.now() + 60_000,
    });

    expect(res.valid).toBe(true);
    expect(res.matchedKey).toBe("previous");
  });

  it("integrates with admitWebhookRequestWithRotation in hmacSigner.ts for v1 signatures", () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const config = createRotationTransition("whsec_inbound_old", "kid_1", 60_000, nowMs);

    const oldV1Sig = signPayloadV1(payload, "whsec_inbound_old", nowSec);
    const admitted = admitWebhookRequestWithRotation(
      payload,
      config,
      oldV1Sig,
      String(nowSec),
      300,
      { now: nowMs + 10_000 },
    );
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.matchedKey).toBe("previous");
    }

    const rejected = admitWebhookRequestWithRotation(
      payload,
      config,
      oldV1Sig,
      String(nowSec),
      300,
      { now: nowMs + 120_000 },
    );
    expect(rejected.ok).toBe(false);
  });
});
