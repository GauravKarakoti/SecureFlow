import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isMockAuthEnabled } from "./mock-auth";

describe("isMockAuthEnabled", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEXT_PUBLIC_MOCK_AUTH;
    delete process.env.ALLOW_MOCK_AUTH;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("is disabled by default", () => {
    expect(isMockAuthEnabled()).toBe(false);
  });

  it("stays disabled when only the public flag is set (the leak case)", () => {
    process.env.NEXT_PUBLIC_MOCK_AUTH = "true";
    expect(isMockAuthEnabled()).toBe(false);
  });

  it("stays disabled when only the server-only flag is set", () => {
    process.env.ALLOW_MOCK_AUTH = "true";
    expect(isMockAuthEnabled()).toBe(false);
  });

  it('is enabled only when both flags are exactly "true"', () => {
    process.env.NEXT_PUBLIC_MOCK_AUTH = "true";
    process.env.ALLOW_MOCK_AUTH = "true";
    expect(isMockAuthEnabled()).toBe(true);
  });

  it('treats any non-"true" value as disabled', () => {
    process.env.NEXT_PUBLIC_MOCK_AUTH = "true";
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      process.env.ALLOW_MOCK_AUTH = value;
      expect(isMockAuthEnabled()).toBe(false);
    }
  });
});
