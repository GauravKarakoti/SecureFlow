import { describe, expect, it } from "vitest";
import { getGitHubAppCredentials, WebhookConfigurationError } from "./app-auth";

describe("getGitHubAppCredentials", () => {
  it("returns the credentials for a well-formed environment", () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    });
    expect(creds.appId).toBe("123456");
    expect(creds.privateKey).toContain("abc");
  });

  it("trims whitespace around the app id", () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: "  123456  ",
      GITHUB_PRIVATE_KEY: "key",
    });
    expect(creds.appId).toBe("123456");
  });

  it("throws a WebhookConfigurationError when GITHUB_APP_ID is missing or blank", () => {
    expect(() => getGitHubAppCredentials({ GITHUB_PRIVATE_KEY: "key" })).toThrow(
      WebhookConfigurationError,
    );
    expect(() =>
      getGitHubAppCredentials({ GITHUB_APP_ID: "   ", GITHUB_PRIVATE_KEY: "key" }),
    ).toThrow("GITHUB_APP_ID is not set");
  });

  it("throws a WebhookConfigurationError when GITHUB_PRIVATE_KEY is missing or blank", () => {
    expect(() => getGitHubAppCredentials({ GITHUB_APP_ID: "123456" })).toThrow(
      WebhookConfigurationError,
    );
    expect(() =>
      getGitHubAppCredentials({ GITHUB_APP_ID: "123456", GITHUB_PRIVATE_KEY: "   " }),
    ).toThrow("GITHUB_PRIVATE_KEY is not set");
  });

  it("unfolds literal \\n sequences in single-line env vars into real newlines", () => {
    // Keys are commonly stored as a single line with literal "\n" sequences.
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });
    expect(creds.privateKey).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("leaves an already-multiline key untouched", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const creds = getGitHubAppCredentials({ GITHUB_APP_ID: "123456", GITHUB_PRIVATE_KEY: key });
    expect(creds.privateKey).toBe(key);
  });
});
