import { describe, it, expect } from "vitest";
import {
  normalizeFindingTypeEnum,
  normalizePolicyDecisionEnum,
  normalizePrStatusEnum,
  normalizePrStateEnum,
} from "./finding-taxonomy";

describe("finding-taxonomy enum conversions (#633)", () => {
  describe("normalizeFindingTypeEnum", () => {
    it("maps standard secret names to SECRET enum", () => {
      expect(normalizeFindingTypeEnum("SECRET")).toBe("SECRET");
      expect(normalizeFindingTypeEnum("Secret")).toBe("SECRET");
      expect(normalizeFindingTypeEnum("Hardcoded Secret")).toBe("SECRET");
      expect(normalizeFindingTypeEnum("hardcoded_api_key")).toBe("SECRET");
      expect(normalizeFindingTypeEnum("Data Leak")).toBe("SECRET");
      expect(normalizeFindingTypeEnum("Contextual Leak")).toBe("SECRET");
    });

    it("maps standard vulnerability names to VULNERABILITY enum", () => {
      expect(normalizeFindingTypeEnum("VULNERABILITY")).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("Vulnerability")).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("SQL Injection")).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("XSS")).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("Logic Flaw")).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("Command Injection")).toBe("VULNERABILITY");
    });

    it("maps misconfiguration names to MISCONFIG enum", () => {
      expect(normalizeFindingTypeEnum("MISCONFIG")).toBe("MISCONFIG");
      expect(normalizeFindingTypeEnum("Misconfig")).toBe("MISCONFIG");
      expect(normalizeFindingTypeEnum("Security Misconfiguration")).toBe("MISCONFIG");
      expect(normalizeFindingTypeEnum("Insecure Headers")).toBe("MISCONFIG");
    });

    it("maps unknown or null values to VULNERABILITY fallback enum", () => {
      expect(normalizeFindingTypeEnum(null)).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum(undefined)).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("")).toBe("VULNERABILITY");
      expect(normalizeFindingTypeEnum("arbitrary_unknown_issue")).toBe("VULNERABILITY");
    });
  });

  describe("normalizePolicyDecisionEnum", () => {
    it("maps PASS variants to PASS", () => {
      expect(normalizePolicyDecisionEnum("PASS")).toBe("PASS");
      expect(normalizePolicyDecisionEnum("pass")).toBe("PASS");
      expect(normalizePolicyDecisionEnum("APPROVED")).toBe("PASS");
      expect(normalizePolicyDecisionEnum("success")).toBe("PASS");
    });

    it("maps REVIEW variants to REVIEW", () => {
      expect(normalizePolicyDecisionEnum("REVIEW REQUIRED")).toBe("REVIEW");
      expect(normalizePolicyDecisionEnum("review_required")).toBe("REVIEW");
      expect(normalizePolicyDecisionEnum("REVIEW")).toBe("REVIEW");
      expect(normalizePolicyDecisionEnum(null)).toBe("REVIEW");
    });

    it("maps BLOCK / FAILURE variants to BLOCK", () => {
      expect(normalizePolicyDecisionEnum("BLOCK")).toBe("BLOCK");
      expect(normalizePolicyDecisionEnum("BLOCKED")).toBe("BLOCK");
      expect(normalizePolicyDecisionEnum("fail")).toBe("BLOCK");
      expect(normalizePolicyDecisionEnum("FAILURE")).toBe("BLOCK");
    });
  });

  describe("normalizePrStatusEnum", () => {
    it("maps status variants to PRStatus enum", () => {
      expect(normalizePrStatusEnum("PASS")).toBe("PASS");
      expect(normalizePrStatusEnum("pass")).toBe("PASS");
      expect(normalizePrStatusEnum("REVIEW REQUIRED")).toBe("REVIEW_REQUIRED");
      expect(normalizePrStatusEnum("review_required")).toBe("REVIEW_REQUIRED");
      expect(normalizePrStatusEnum("BLOCKED")).toBe("BLOCKED");
      expect(normalizePrStatusEnum("block")).toBe("BLOCKED");
      expect(normalizePrStatusEnum(undefined)).toBe("REVIEW_REQUIRED");
    });
  });

  describe("normalizePrStateEnum", () => {
    it("maps github state strings to PRState enum", () => {
      expect(normalizePrStateEnum("open")).toBe("OPEN");
      expect(normalizePrStateEnum("OPEN")).toBe("OPEN");
      expect(normalizePrStateEnum("closed")).toBe("CLOSED");
      expect(normalizePrStateEnum("CLOSED")).toBe("CLOSED");
      expect(normalizePrStateEnum("merged")).toBe("MERGED");
      expect(normalizePrStateEnum(null)).toBe("OPEN");
    });
  });
});
