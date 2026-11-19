import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_API_URL,
  DEFAULT_GITHUB_WEB_URL,
  createGitHubAppClient,
  getGitHubApiUrl,
  getGitHubAppCredentials,
  getGitHubWebUrl,
  WebhookConfigurationError,
} from "./app-auth";

const testPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3y
-----END RSA PRIVATE KEY-----`;

describe("getGitHubAppCredentials", () => {
  it("returns the credentials for a well-formed environment", () => {
    const creds = getGitHubAppCredentials({
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    });
    expect(creds.appId).toBe("123456");
    expect(creds.privateKey).toContain("abc");
    expect(creds.apiUrl).toBe(DEFAULT_GITHUB_API_URL);
    expect(creds.webUrl).toBe(DEFAULT_GITHUB_WEB_URL);
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

describe("getGitHubApiUrl", () => {
  it("defaults to https://api.github.com when not set", () => {
    expect(getGitHubApiUrl({})).toBe("https://api.github.com");
  });

  it("returns configured custom API URL and strips trailing slashes", () => {
    expect(getGitHubApiUrl({ GITHUB_API_URL: "https://ghe.mycorp.com/api/v3/" })).toBe(
      "https://ghe.mycorp.com/api/v3",
    );
  });

  it("throws WebhookConfigurationError on malformed URL", () => {
    expect(() => getGitHubApiUrl({ GITHUB_API_URL: "not-a-url" })).toThrow(
      WebhookConfigurationError,
    );
  });

  it("rejects non-HTTPS URL in production mode", () => {
    expect(() =>
      getGitHubApiUrl({
        NODE_ENV: "production",
        GITHUB_API_URL: "http://ghe.mycorp.com/api/v3",
      }),
    ).toThrow(/GITHUB_API_URL must use HTTPS in production/);
  });

  it("allows non-HTTPS URL in development mode", () => {
    expect(
      getGitHubApiUrl({
        NODE_ENV: "development",
        GITHUB_API_URL: "http://localhost:8080/api/v3",
      }),
    ).toBe("http://localhost:8080/api/v3");
  });
});

describe("getGitHubWebUrl", () => {
  it("defaults to https://github.com when not set", () => {
    expect(getGitHubWebUrl({})).toBe("https://github.com");
  });

  it("uses explicit GITHUB_WEB_URL and strips trailing slashes", () => {
    expect(getGitHubWebUrl({ GITHUB_WEB_URL: "https://ghe.mycorp.com/" })).toBe(
      "https://ghe.mycorp.com",
    );
  });

  it("infers origin from custom GITHUB_API_URL when GITHUB_WEB_URL is not set", () => {
    expect(getGitHubWebUrl({ GITHUB_API_URL: "https://ghe.mycorp.com/api/v3" })).toBe(
      "https://ghe.mycorp.com",
    );
  });

  it("keeps https://github.com when GITHUB_API_URL is the default api.github.com", () => {
    expect(getGitHubWebUrl({ GITHUB_API_URL: "https://api.github.com" })).toBe(
      "https://github.com",
    );
  });

  it("rejects non-HTTPS URL in production mode", () => {
    expect(() =>
      getGitHubWebUrl({
        NODE_ENV: "production",
        GITHUB_WEB_URL: "http://ghe.mycorp.com",
      }),
    ).toThrow(/GITHUB_WEB_URL must use HTTPS in production/);
  });
});

describe("createGitHubAppClient", () => {
  it("creates an App client with default api.github.com baseUrl", () => {
    const app = createGitHubAppClient({
      appId: "123456",
      privateKey: testPrivateKey,
    });
    expect(app).toBeDefined();
    expect(app.octokit.request.endpoint.DEFAULTS.baseUrl).toBe("https://api.github.com");
  });

  it("creates an App client with custom baseUrl from options", () => {
    const app = createGitHubAppClient({
      appId: "123456",
      privateKey: testPrivateKey,
      apiUrl: "https://ghe.mycorp.com/api/v3",
    });
    expect(app).toBeDefined();
    expect(app.octokit.request.endpoint.DEFAULTS.baseUrl).toBe("https://ghe.mycorp.com/api/v3");
  });

  it("creates an App client reading credentials and custom URL from env", () => {
    const app = createGitHubAppClient(
      {},
      {
        GITHUB_APP_ID: "123456",
        GITHUB_PRIVATE_KEY: testPrivateKey,
        GITHUB_API_URL: "https://enterprise.internal/api/v3",
      },
    );
    expect(app).toBeDefined();
    expect(app.octokit.request.endpoint.DEFAULTS.baseUrl).toBe(
      "https://enterprise.internal/api/v3",
    );
  });

  it("rejects non-HTTPS URL when created in production mode", () => {
    expect(() =>
      createGitHubAppClient(
        {},
        {
          NODE_ENV: "production",
          GITHUB_APP_ID: "123456",
          GITHUB_PRIVATE_KEY: testPrivateKey,
          GITHUB_API_URL: "http://enterprise.internal/api/v3",
        },
      ),
    ).toThrow(/GITHUB_API_URL must use HTTPS in production/);
  });
});
