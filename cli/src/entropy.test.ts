import { describe, it, expect } from "vitest";
import {
  calculateShannonEntropy,
  isBenignSecretCandidate,
  hasHighEntropy,
  UUID_REGEX,
  BENIGN_SECRET_WHITELIST_EXACT,
  BENIGN_PATTERN_REGEX,
} from "./entropy.js";

describe("cli/src/entropy.ts unit tests (#1512)", () => {
  describe("calculateShannonEntropy", () => {
    it("returns 0 for empty or empty-like strings", () => {
      expect(calculateShannonEntropy("")).toBe(0);
    });

    it("returns 0 for single character repeated strings (zero uncertainty)", () => {
      expect(calculateShannonEntropy("aaaaaaaaaa")).toBe(0);
      expect(calculateShannonEntropy("1111111111")).toBe(0);
    });

    it("returns low entropy for repetitive alternating sequences", () => {
      const entropy = calculateShannonEntropy("abababababababab");
      expect(entropy).toBe(1); // exactly 1 bit for 2 equiprobable symbols
    });

    it("returns higher entropy for diverse, random cryptographic strings", () => {
      // 16 distinct hex characters
      const hex = "0123456789abcdef";
      const entropy = calculateShannonEntropy(hex);
      expect(entropy).toBe(4); // log2(16) = 4 bits per char

      // Base64-like random key
      const key = "xK9#mQ2$vL8@pW1!";
      expect(calculateShannonEntropy(key)).toBeGreaterThan(3.5);
    });
  });

  describe("UUID_REGEX", () => {
    it("matches valid v4 UUIDs", () => {
      expect(UUID_REGEX.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
      expect(UUID_REGEX.test("c9bf9e57-1685-4c89-bafb-ff5af830be8a")).toBe(true);
      expect(UUID_REGEX.test("C9BF9E57-1685-4C89-BAFB-FF5AF830BE8A")).toBe(true);
    });

    it("does not match non-UUID strings", () => {
      expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
      expect(UUID_REGEX.test("custom_app_token_string_12345678")).toBe(false);
      expect(UUID_REGEX.test("12345678-1234-1234-1234")).toBe(false);
    });
  });

  describe("isBenignSecretCandidate", () => {
    it("identifies exact benign whitelist strings", () => {
      for (const token of BENIGN_SECRET_WHITELIST_EXACT) {
        expect(isBenignSecretCandidate(token)).toBe(true);
      }
    });

    it("identifies common documentation placeholder patterns", () => {
      expect(isBenignSecretCandidate("your_api_key_here")).toBe(true);
      expect(isBenignSecretCandidate("YOUR-API-KEY-HERE")).toBe(true);
      expect(isBenignSecretCandidate("dummy_token")).toBe(true);
      expect(isBenignSecretCandidate("mock_secret")).toBe(true);
      expect(isBenignSecretCandidate("sample_token")).toBe(true);
      expect(isBenignSecretCandidate("test_key")).toBe(true);
    });

    it("identifies UUIDs as benign identifiers", () => {
      expect(isBenignSecretCandidate("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    });

    it("identifies repeated characters as benign mask", () => {
      expect(isBenignSecretCandidate("****************")).toBe(true);
      expect(isBenignSecretCandidate("xxxxxxxxxxxxxxxx")).toBe(true);
      expect(isBenignSecretCandidate("0000000000000000")).toBe(true);
    });

    it("does not whitelist real or high-entropy credentials", () => {
      expect(isBenignSecretCandidate("custom_secret_key_prod_abcdef987654321")).toBe(false);
      expect(isBenignSecretCandidate("production_secret_token_val_99887766")).toBe(false);
      expect(isBenignSecretCandidate("authorization_jwt_bearer_signature_xyz")).toBe(false);
      expect(isBenignSecretCandidate("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(false);
    });
  });

  describe("hasHighEntropy", () => {
    it("returns false for short or benign tokens", () => {
      expect(hasHighEntropy("short")).toBe(false);
      expect(hasHighEntropy("your_api_key_here")).toBe(false);
      expect(hasHighEntropy("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    });

    it("returns true for high-entropy random API secrets", () => {
      expect(hasHighEntropy("4f8a9b2c7e1d5f3a8b0c6e4d2a9f1b7e")).toBe(true);
      expect(hasHighEntropy("dGhpcy1pcy1hLWhpZ2gtZW50cm9weS1zZWNyZXQta2V5")).toBe(true);
    });

    it("evaluates custom entropy thresholds", () => {
      const moderateEntropy = "abcde12345!@#$%";
      expect(hasHighEntropy(moderateEntropy, 4.5)).toBe(false);
      expect(hasHighEntropy(moderateEntropy, 2.0)).toBe(true);
    });

    it("rejects repetitive low-entropy sequences even if long", () => {
      const repetitiveString = "abababababababababababababababab";
      expect(hasHighEntropy(repetitiveString, 2.0)).toBe(false);
    });

    it("handles edge cases gracefully", () => {
      expect(hasHighEntropy("")).toBe(false);
      expect(hasHighEntropy("   ")).toBe(false);
      expect(hasHighEntropy("1234567")).toBe(false);
    });
  });

  describe("BENIGN_PATTERN_REGEX exhaustive checks", () => {
    it("matches all supported placeholder naming variants", () => {
      expect(BENIGN_PATTERN_REGEX.test("your_api_key")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("your-api-key")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("your_secret")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("your-token")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("your_password")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("your_api_key_here")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("dummy_token")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("mock_key")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("fake_secret")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("sample_token")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("test_key")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("example_token")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("0000000000000000")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("1111111111111111")).toBe(true);
      expect(BENIGN_PATTERN_REGEX.test("xxxxxxxxxxxxxxxx")).toBe(true);
    });

    it("does not match operational credentials", () => {
      expect(BENIGN_PATTERN_REGEX.test("sk_live_abcdef1234567890")).toBe(false);
      expect(BENIGN_PATTERN_REGEX.test("bearer_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(false);
    });

    it("verifies whitespace trimming and casing resilience in isBenignSecretCandidate", () => {
      expect(isBenignSecretCandidate("  your_api_key_here  ")).toBe(true);
      expect(isBenignSecretCandidate("DUMMY_SECRET")).toBe(true);
      expect(isBenignSecretCandidate("")).toBe(true);
      expect(isBenignSecretCandidate("   ")).toBe(true);
    });
  });
});
