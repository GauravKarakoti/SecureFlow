import { describe, expect, it } from "vitest";
import { formatEnvErrors, validateEnv } from "./env";

const validPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3y
-----END RSA PRIVATE KEY-----`;

const validEnv = {
  DATABASE_URL: "postgres://localhost/test",
  DATABASE_POOL_URL: "postgres://localhost/test",
  GROQ_API_KEY: "test-groq-super-secret-key-12345",
  GITHUB_APP_ID: "123",
  GITHUB_WEBHOOK_SECRET: "webhook-secret-98765",
  GITHUB_PRIVATE_KEY: validPrivateKey,
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret-abcde",
  AUTH_SECRET: "auth-secret-top-secret-54321",
  AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

describe("environment validation (src/lib/env.ts)", () => {
  it("accepts valid environment variables", () => {
    expect(validateEnv(validEnv)).toMatchObject(validEnv);
  });

  it("accepts valid private key with literal \\n sequences", () => {
    const envWithEscapedNewlines = {
      ...validEnv,
      GITHUB_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nMIIEowIBAAKCAQEA\\n-----END PRIVATE KEY-----",
    };
    expect(validateEnv(envWithEscapedNewlines)).toBeDefined();
  });

  it("fails fast on missing required variables with a clear message naming them", () => {
    const { GROQ_API_KEY, DATABASE_URL, ...incompleteEnv } = validEnv;

    expect(() => validateEnv(incompleteEnv)).toThrowError(/DATABASE_URL/);
    expect(() => validateEnv(incompleteEnv)).toThrowError(/GROQ_API_KEY/);
  });

  it("rejects invalid or malformed private keys (e.g. missing header/footer)", () => {
    const invalidKeyEnv = {
      ...validEnv,
      GITHUB_PRIVATE_KEY: "broken-private-key-without-header-or-footer",
    };

    expect(() => validateEnv(invalidKeyEnv)).toThrowError(/Invalid private key format/);
  });

  it("rejects negative or non-numeric TRUSTED_PROXY_HOP_COUNT", () => {
    const negativeHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "-1",
    };
    expect(() => validateEnv(negativeHopEnv)).toThrowError(
      /TRUSTED_PROXY_HOP_COUNT must be a non-negative integer/,
    );

    const nonNumericHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "invalid_hops",
    };
    expect(() => validateEnv(nonNumericHopEnv)).toThrowError(
      /TRUSTED_PROXY_HOP_COUNT must be a non-negative integer/,
    );

    const floatHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "1.5",
    };
    expect(() => validateEnv(floatHopEnv)).toThrowError(
      /TRUSTED_PROXY_HOP_COUNT must be a non-negative integer/,
    );
  });

  it("accepts valid TRUSTED_PROXY_HOP_COUNT", () => {
    const validHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "2",
    };
    expect(validateEnv(validHopEnv).TRUSTED_PROXY_HOP_COUNT).toBe("2");
  });

  it("rejects malformed URLs for AUTH_URL and NEXT_PUBLIC_APP_URL", () => {
    const badUrlEnv = {
      ...validEnv,
      AUTH_URL: "not-a-valid-url",
    };
    expect(() => validateEnv(badUrlEnv)).toThrowError(/AUTH_URL must be a valid URL/);
  });

  it("never prints secret values in error messages", () => {
    const badSecretEnv = {
      ...validEnv,
      GROQ_API_KEY: "", // invalid empty string
      GITHUB_PRIVATE_KEY: "malformed-secret-private-key-data-123456789",
      AUTH_SECRET: "",
    };

    try {
      validateEnv(badSecretEnv);
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      expect(err.message).not.toContain("malformed-secret-private-key-data-123456789");
      expect(err.message).toContain("GITHUB_PRIVATE_KEY");
      expect(err.message).toContain("[value redacted]");
    }
  });

  it("allows optional variables to be omitted", () => {
    expect(validateEnv(validEnv)).toBeDefined();
  });
});
