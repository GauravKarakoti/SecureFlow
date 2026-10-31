/**
 * Unit tests for GitLab webhook verification helpers (#1466).
 */

import { describe, it, expect } from "vitest";
import {
  parseGitLabToken,
  parseGitLabEvent,
  verifyGitLabToken,
  isTrackedGitLabEvent,
  safeGitLabEventLabel,
} from "./gitlab-verification";

describe("gitlab-verification", () => {
  describe("parseGitLabToken", () => {
    it("returns the trimmed token from a valid header", () => {
      expect(parseGitLabToken("my-secret-token")).toBe("my-secret-token");
    });

    it("trims surrounding whitespace", () => {
      expect(parseGitLabToken("  token-value  ")).toBe("token-value");
    });

    it("returns null for null input", () => {
      expect(parseGitLabToken(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseGitLabToken("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseGitLabToken("   ")).toBeNull();
    });
  });

  describe("parseGitLabEvent", () => {
    it("returns the event name from a valid header", () => {
      expect(parseGitLabEvent("Merge Request Hook")).toBe("Merge Request Hook");
    });

    it("returns null for null input", () => {
      expect(parseGitLabEvent(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseGitLabEvent("")).toBeNull();
    });
  });

  describe("verifyGitLabToken", () => {
    const SECRET = "my-super-secret-gitlab-token";

    it("returns true for matching tokens", () => {
      expect(verifyGitLabToken(SECRET, SECRET)).toBe(true);
    });

    it("returns false for mismatched tokens", () => {
      expect(verifyGitLabToken("wrong-token", SECRET)).toBe(false);
    });

    it("returns false for empty received token", () => {
      expect(verifyGitLabToken("", SECRET)).toBe(false);
    });

    it("returns false for empty expected secret", () => {
      expect(verifyGitLabToken(SECRET, "")).toBe(false);
    });

    it("returns false when lengths differ (prevents padding oracle)", () => {
      expect(verifyGitLabToken("short", SECRET)).toBe(false);
    });
  });

  describe("isTrackedGitLabEvent", () => {
    it("returns true for tracked Merge Request Hook", () => {
      expect(isTrackedGitLabEvent("Merge Request Hook")).toBe(true);
    });

    it("returns true for tracked Push Hook", () => {
      expect(isTrackedGitLabEvent("Push Hook")).toBe(true);
    });

    it("returns true for tracked Pipeline Hook", () => {
      expect(isTrackedGitLabEvent("Pipeline Hook")).toBe(true);
    });

    it("returns false for untracked Note Hook", () => {
      expect(isTrackedGitLabEvent("Note Hook")).toBe(false);
    });

    it("returns false for unknown event", () => {
      expect(isTrackedGitLabEvent("Unknown Event")).toBe(false);
    });
  });

  describe("safeGitLabEventLabel", () => {
    it("returns the event name for tracked events", () => {
      expect(safeGitLabEventLabel("Merge Request Hook")).toBe("Merge Request Hook");
    });

    it("returns 'untracked' for known but untracked events", () => {
      expect(safeGitLabEventLabel("Note Hook")).toBe("untracked");
    });

    it("returns 'unknown' for null", () => {
      expect(safeGitLabEventLabel(null)).toBe("unknown");
    });

    it("returns 'unknown' for over-length strings", () => {
      expect(safeGitLabEventLabel("x".repeat(65))).toBe("unknown");
    });
  });
});

