import { describe, expect, it } from "vitest";
import { validateEnv } from "./env";

const validEnv = {
  DATABASE_URL: "postgres://localhost/test",
  DATABASE_POOL_URL: "postgres://localhost/test",
  GROQ_API_KEY: "test-key",
  GITHUB_APP_ID: "123",
  GITHUB_WEBHOOK_SECRET: "secret",
  GITHUB_PRIVATE_KEY: "private-key",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  AUTH_SECRET: "auth-secret",
  AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

describe("environment validation", () => {
  it("accepts valid environment variables", () => {
    expect(validateEnv(validEnv)).toMatchObject(validEnv);
  });

  it("rejects missing required variables", () => {
    const { GROQ_API_KEY, ...missingKey } = validEnv;

    expect(() => validateEnv(missingKey)).toThrow("Invalid environment variables");
  });

  it("allows optional variables to be omitted", () => {
    expect(validateEnv(validEnv)).toBeDefined();
  });
});
