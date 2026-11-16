import { describe, it, expect } from "vitest";
import MockGroq, {
  SAFE_MOCK_GROQ_API_KEY,
  assertSafeMockCredentials,
  mockCreate,
  mockStream,
} from "../__mocks__/groq-sdk";
import NextAuth from "../__mocks__/next-auth/index.js";
import { SAFE_MOCK_SESSION } from "../__mocks__/next-auth/index.js";
import githubProvider from "../__mocks__/next-auth/providers/github";
import { auth, SAFE_MOCK_AUTH_SESSION } from "../__mocks__/auth";
import { hasHighEntropy, isBenignSecretCandidate } from "../cli/src/entropy.js";

describe("Mock Data Credentials Security Audit (#1303, #1354)", () => {
  describe("groq-sdk mock audit", () => {
    it("provides safe synthetic mock API key without real secrets", () => {
      expect(SAFE_MOCK_GROQ_API_KEY).toContain("mock");
      expect(SAFE_MOCK_GROQ_API_KEY).not.toMatch(/^gsk_[a-zA-Z0-9]{30,}$/);
    });

    it("initializes MockGroq with safe mock token", () => {
      const client = new MockGroq({ apiKey: "gsk_test_safe_mock_key" });
      expect(client.apiKey).toBe(SAFE_MOCK_GROQ_API_KEY);
      expect(client.chat.completions.create).toBe(mockCreate);
      expect(MockGroq.mockStream).toBe(mockStream);
    });

    it("assertSafeMockCredentials permits safe test tokens and rejects suspicious keys", () => {
      expect(assertSafeMockCredentials("gsk_mock_key")).toBe(true);
      expect(assertSafeMockCredentials("gsk_test_key")).toBe(true);
      expect(assertSafeMockCredentials(undefined)).toBe(true);
      expect(() => assertSafeMockCredentials("gsk_liveproductionkeythatshouldnotbehere")).toThrow(
        /SECURITY AUDIT/,
      );
    });
  });

  describe("next-auth mock audit", () => {
    it("provides synthetic session fixture without real tokens or private secrets", () => {
      expect(SAFE_MOCK_SESSION.user.email).toContain("secureflow.internal.test");
      expect(SAFE_MOCK_SESSION).not.toHaveProperty("accessToken");
      expect(SAFE_MOCK_SESSION).not.toHaveProperty("secret");
      expect(Object.isFrozen(SAFE_MOCK_SESSION)).toBe(true);
    });

    it("creates next-auth instance mock with safe handlers", async () => {
      const instance = NextAuth();
      expect(instance).toBeDefined();
      expect(typeof instance.signIn).toBe("function");
      expect(typeof instance.signOut).toBe("function");
      const authResult = await instance.auth();
      expect(authResult).toBeNull();
    });

    it("mocks github provider with dummy non-functional secrets", () => {
      const provider = githubProvider();
      expect(provider.id).toBe("github");
      expect(provider.config.clientId).toBe("mock_key");
      expect(provider.config.clientSecret).toBe("mock_secret");
    });
  });

  describe("auth mock audit", () => {
    it("returns safe mock session when invoked directly", async () => {
      const session = await auth()();
      expect(session).toBe(SAFE_MOCK_SESSION);
      expect(SAFE_MOCK_AUTH_SESSION).toBe(SAFE_MOCK_SESSION);
    });

    it("passes through handler functions as middleware wrapper", async () => {
      const testHandler = (req: { url: string }) => `handled:${req.url}`;
      const wrapped = auth(testHandler);
      const res = await wrapped({ url: "/test" });
      expect(res).toBe("handled:/test");
    });
  });

  describe("armoriq mock audit", () => {
    it("provides safe synthetic mock tokens without live credentials", async () => {
      const { ArmorIQClient, SAFE_MOCK_ARMORIQ_API_KEY, SAFE_MOCK_INTENT_TOKEN } =
        await import("../__mocks__/@armoriq/sdk");
      expect(SAFE_MOCK_ARMORIQ_API_KEY).toContain("mock");
      expect(SAFE_MOCK_INTENT_TOKEN).toContain("mock");
      const client = new ArmorIQClient();
      expect(client.apiKey).toBe(SAFE_MOCK_ARMORIQ_API_KEY);
    });

    it("uses entropy-safe forms for mock credentials and token-like outputs", async () => {
      const {
        ArmorIQClient,
        SAFE_MOCK_ARMORIQ_API_KEY,
        SAFE_MOCK_INTENT_TOKEN,
        mockVerifyIntentToken,
        mockSignIntent,
      } = await import("../__mocks__/@armoriq/sdk");
      const provider = githubProvider();
      const client = new ArmorIQClient();
      const verified = await mockVerifyIntentToken("mock_token");
      const signed = await mockSignIntent({});
      const generated = await client.getIntentToken({}, {});
      const values = [
        SAFE_MOCK_GROQ_API_KEY,
        SAFE_MOCK_ARMORIQ_API_KEY,
        SAFE_MOCK_INTENT_TOKEN,
        provider.config.clientId,
        provider.config.clientSecret,
        verified.proofHash,
        verified.signature,
        signed.signature,
        generated.token,
        generated.tokenId,
      ].filter((value): value is string => typeof value === "string");

      expect(values.every(isBenignSecretCandidate)).toBe(true);
      expect(values.every((value) => !hasHighEntropy(value))).toBe(true);
      expect(client.apiKey).toBe(SAFE_MOCK_ARMORIQ_API_KEY);
    });

    it("supports standardized blocked intent, policy violation, and degraded helpers (#1355)", async () => {
      const {
        setMockArmorIQBlockedIntent,
        setMockArmorIQPolicyViolation,
        setMockArmorIQDegraded,
        resetMockArmorIQ,
        mockArmorIQState,
        ArmorIQClient,
        ArmorIQTimeoutError,
        ArmorIQUnreachableError,
      } = await import("../__mocks__/@armoriq/sdk");

      // 1. Blocked intent simulation
      setMockArmorIQBlockedIntent("Malicious injection attempt", "PROMPT_INJECTION_DETECTED");
      expect(mockArmorIQState.decision).toBe("BLOCK");
      expect(mockArmorIQState.ruleMatched).toBe("PROMPT_INJECTION_DETECTED");
      expect(mockArmorIQState.justification).toBe("Malicious injection attempt");
      expect(mockArmorIQState.validProof).toBe(false);

      // 2. Policy violation simulation
      setMockArmorIQPolicyViolation("deny:path_traversal", "Sensitive path traversal detected");
      expect(mockArmorIQState.decision).toBe("BLOCK");
      expect(mockArmorIQState.ruleMatched).toBe("deny:path_traversal");
      expect(mockArmorIQState.justification).toBe("Sensitive path traversal detected");

      // 3. Degraded mode - unreachable
      setMockArmorIQDegraded(true, "unreachable");
      expect(mockArmorIQState.shouldFailUnreachable).toBe(true);
      expect(mockArmorIQState.shouldTimeout).toBe(false);

      const client = new ArmorIQClient();
      await expect(client.verifyToken("test-token")).rejects.toThrow(ArmorIQUnreachableError);
      await expect(client.getIntentToken({}, {})).rejects.toThrow(ArmorIQUnreachableError);

      // 4. Degraded mode - timeout
      setMockArmorIQDegraded(true, "timeout");
      expect(mockArmorIQState.shouldTimeout).toBe(true);
      expect(mockArmorIQState.shouldFailUnreachable).toBe(false);
      await expect(client.verifyIntentToken("test-token")).rejects.toThrow(ArmorIQTimeoutError);

      // 5. Reset mock state
      resetMockArmorIQ();
      expect(mockArmorIQState.decision).toBe("ALLOW");
      expect(mockArmorIQState.shouldTimeout).toBe(false);
      expect(mockArmorIQState.shouldFailUnreachable).toBe(false);

      const tokenResult = await client.getIntentToken({ plan: "test" }, { policy: "strict" });
      expect(tokenResult.token).toBeDefined();
      expect(tokenResult.tokenId).toBe("mock_token");
    });
  });
});
