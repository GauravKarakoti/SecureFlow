/**
 * Unit tests for Bitbucket webhook verification helpers (#1466).
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import {
  parseBitbucketSignature,
  parseBitbucketRequestUuid,
  parseBitbucketEventKey,
  computeBitbucketHmac,
  verifyBitbucketSignature,
  isTrackedBitbucketEvent,
  safeBitbucketEventLabel,
} from "./bitbucket-verification";

const SECRET = "bitbucket-webhook-secret-abc";
const BODY = JSON.stringify({ repository: { full_name: "org/repo" } });

function makeHmacHeader(body: string = BODY, secret: string = SECRET): string {
  const hex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

describe("bitbucket-verification", () => {
  describe("parseBitbucketSignature", () => {
    it("parses a valid sha256= header", () => {
      const header = makeHmacHeader();
      const parsed = parseBitbucketSignature(header);
      expect(parsed).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns null for null input", () => {
      expect(parseBitbucketSignature(null)).toBeNull();
    });

    it("returns null for header without sha256= prefix", () => {
      expect(parseBitbucketSignature("md5=abc123")).toBeNull();
    });

    it("returns null for sha256= with non-hex characters", () => {
      expect(parseBitbucketSignature("sha256=zzzz")).toBeNull();
    });

    it("normalises to lowercase", () => {
      const upper = "sha256=" + "A".repeat(64);
      const result = parseBitbucketSignature(upper);
      expect(result).toBe("a".repeat(64));
    });
  });

  describe("parseBitbucketRequestUuid", () => {
    it("returns a normalised UUID", () => {
      expect(parseBitbucketRequestUuid("ABC-123")).toBe("abc-123");
    });

    it("returns null for null input", () => {
      expect(parseBitbucketRequestUuid(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseBitbucketRequestUuid("")).toBeNull();
    });
  });

  describe("parseBitbucketEventKey", () => {
    it("returns the event key for a valid header", () => {
      expect(parseBitbucketEventKey("repo:push")).toBe("repo:push");
    });

    it("returns null for null input", () => {
      expect(parseBitbucketEventKey(null)).toBeNull();
    });
  });

  describe("computeBitbucketHmac", () => {
    it("produces the same digest as the reference implementation", () => {
      const expected = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
      expect(computeBitbucketHmac(SECRET, BODY)).toBe(expected);
    });
  });

  describe("verifyBitbucketSignature", () => {
    it("returns true for a valid signature", () => {
      const hex = computeBitbucketHmac(SECRET, BODY);
      expect(verifyBitbucketSignature(hex, SECRET, BODY)).toBe(true);
    });

    it("returns false for a tampered body", () => {
      const hex = computeBitbucketHmac(SECRET, BODY);
      expect(verifyBitbucketSignature(hex, SECRET, BODY + "tampered")).toBe(false);
    });

    it("returns false for a wrong secret", () => {
      const hex = computeBitbucketHmac(SECRET, BODY);
      expect(verifyBitbucketSignature(hex, "wrong-secret", BODY)).toBe(false);
    });

    it("returns false for empty signature hex", () => {
      expect(verifyBitbucketSignature("", SECRET, BODY)).toBe(false);
    });

    it("returns false for empty secret", () => {
      const hex = computeBitbucketHmac(SECRET, BODY);
      expect(verifyBitbucketSignature(hex, "", BODY)).toBe(false);
    });
  });

  describe("isTrackedBitbucketEvent", () => {
    it("returns true for repo:push", () => {
      expect(isTrackedBitbucketEvent("repo:push")).toBe(true);
    });

    it("returns true for pullrequest:created", () => {
      expect(isTrackedBitbucketEvent("pullrequest:created")).toBe(true);
    });

    it("returns true for pullrequest:updated", () => {
      expect(isTrackedBitbucketEvent("pullrequest:updated")).toBe(true);
    });

    it("returns false for pullrequest:comment_created", () => {
      expect(isTrackedBitbucketEvent("pullrequest:comment_created")).toBe(false);
    });

    it("returns false for unknown events", () => {
      expect(isTrackedBitbucketEvent("bogus:event")).toBe(false);
    });
  });

  describe("safeBitbucketEventLabel", () => {
    it("returns the event for tracked events", () => {
      expect(safeBitbucketEventLabel("repo:push")).toBe("repo:push");
    });

    it("returns 'untracked' for known but untracked events", () => {
      expect(safeBitbucketEventLabel("pullrequest:comment_created")).toBe("untracked");
    });

    it("returns 'unknown' for null", () => {
      expect(safeBitbucketEventLabel(null)).toBe("unknown");
    });

    it("returns 'unknown' for strings over 64 characters", () => {
      expect(safeBitbucketEventLabel("x".repeat(65))).toBe("unknown");
    });
  });
});

