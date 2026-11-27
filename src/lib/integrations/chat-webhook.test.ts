import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertChatWebhookUrl,
  maskWebhookUrl,
  encryptWebhookUrl,
  decryptWebhookUrl,
  buildChatAlertPayload,
  sendChatAlert,
  claimCriticalFindingAlert,
  clearInMemoryAlertedFindings,
  dispatchCriticalChatAlert,
  getCriticalAlertDedupeKey,
} from "./chat-webhook";
import * as outbound from "@/lib/queue/outbound-dispatch";

vi.mock("@/lib/queue/redis", () => ({
  redis: null,
}));

const mockFindUniqueUser = vi.hoisted(() => vi.fn());
const mockFindManyFindings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findUnique: mockFindUniqueUser,
    },
    finding: {
      findMany: mockFindManyFindings,
    },
  },
}));

describe("assertChatWebhookUrl", () => {
  const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
  const DISCORD_URL = "https://discord.com/api/webhooks/1234567890/token_abc-123";
  const DISCORD_APP_URL = "https://discordapp.com/api/webhooks/987654321/token_xyz";

  it("accepts a valid Slack incoming webhook URL", () => {
    const res = assertChatWebhookUrl(SLACK_URL);
    expect(res.provider).toBe("slack");
    expect(res.url.href).toBe(SLACK_URL);
  });

  it("accepts a valid Discord webhook URL", () => {
    const res = assertChatWebhookUrl(DISCORD_URL);
    expect(res.provider).toBe("discord");
    expect(res.url.href).toBe(DISCORD_URL);
  });

  it("accepts discordapp.com hostname", () => {
    const res = assertChatWebhookUrl(DISCORD_APP_URL);
    expect(res.provider).toBe("discord");
    expect(res.url.href).toBe(DISCORD_APP_URL);
  });

  it("trims whitespace from URLs", () => {
    const res = assertChatWebhookUrl(`  ${SLACK_URL}  `);
    expect(res.url.href).toBe(SLACK_URL);
  });

  it("rejects empty, null, or missing URLs", () => {
    expect(() => assertChatWebhookUrl("")).toThrow("Webhook URL is missing.");
    expect(() => assertChatWebhookUrl("   ")).toThrow("Webhook URL is missing.");
    expect(() => assertChatWebhookUrl(null as any)).toThrow("Webhook URL is missing.");
    expect(() => assertChatWebhookUrl(undefined as any)).toThrow("Webhook URL is missing.");
  });

  it("rejects non-HTTP or non-HTTPS schemes", () => {
    expect(() => assertChatWebhookUrl("http://hooks.slack.com/services/T000/B000/XXXX")).toThrow(
      /only https is allowed/,
    );
    expect(() => assertChatWebhookUrl("ftp://discord.com/api/webhooks/123/abc")).toThrow(
      /only https is allowed/,
    );
  });

  it("rejects SSRF destinations, private networks, and loopback", () => {
    expect(() => assertChatWebhookUrl("https://127.0.0.1/api/webhooks/123/abc")).toThrow(
      /only Slack.*or Discord/,
    );
    expect(() => assertChatWebhookUrl("https://localhost/services/XXX")).toThrow(
      /only Slack.*or Discord/,
    );
    expect(() => assertChatWebhookUrl("https://169.254.169.254/latest/meta-data")).toThrow(
      /only Slack.*or Discord/,
    );
    expect(() => assertChatWebhookUrl("https://10.0.0.1/api/webhooks/123/abc")).toThrow(
      /only Slack.*or Discord/,
    );
  });

  it("rejects unauthorized external hosts", () => {
    expect(() => assertChatWebhookUrl("https://evil.com/api/webhooks/123/abc")).toThrow(
      /only Slack.*or Discord/,
    );
    expect(() => assertChatWebhookUrl("https://hooks.slack.com.evil.com/services/XXX")).toThrow(
      /only Slack.*or Discord/,
    );
  });

  it("rejects embedded credentials and custom ports", () => {
    expect(() =>
      assertChatWebhookUrl("https://user:pass@hooks.slack.com/services/T000/B000/XXXX"),
    ).toThrow(/must not embed credentials/);
    expect(() => assertChatWebhookUrl("https://discord.com:8443/api/webhooks/123/abc")).toThrow(
      /must not specify a custom port/,
    );
  });

  it("rejects query strings and hash fragments", () => {
    expect(() =>
      assertChatWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX?tracking=1"),
    ).toThrow(/must not include query parameters/);
    expect(() => assertChatWebhookUrl("https://discord.com/api/webhooks/123/abc#hash")).toThrow(
      /must not include query parameters/,
    );
  });

  it("rejects invalid path structures", () => {
    expect(() => assertChatWebhookUrl("https://hooks.slack.com/invalid/path")).toThrow(
      /Slack webhook URL path must start with \/services\//,
    );
    expect(() => assertChatWebhookUrl("https://discord.com/api/channels/123/messages")).toThrow(
      /Discord webhook URL path must match/,
    );
  });
});

describe("maskWebhookUrl", () => {
  it("masks Slack webhook secret tokens", () => {
    const masked = maskWebhookUrl("https://hooks.slack.com/services/T000/B000/SECRET_TOKEN_XYZ");
    expect(masked).toBe("https://hooks.slack.com/services/••••••••");
    expect(masked).not.toContain("SECRET_TOKEN_XYZ");
  });

  it("masks Discord webhook secret tokens", () => {
    const masked = maskWebhookUrl(
      "https://discord.com/api/webhooks/123456789/SECRET_DISCORD_TOKEN",
    );
    expect(masked).toBe("https://discord.com/api/webhooks/123456789/••••••••");
    expect(masked).not.toContain("SECRET_DISCORD_TOKEN");
  });

  it("returns null for empty or null inputs", () => {
    expect(maskWebhookUrl("")).toBeNull();
    expect(maskWebhookUrl(null)).toBeNull();
    expect(maskWebhookUrl(undefined)).toBeNull();
  });
});

describe("encryptWebhookUrl and decryptWebhookUrl", () => {
  const TEST_URL = "https://discord.com/api/webhooks/1234567890/my_secret_token";

  it("encrypts plaintext URL into AES-256-GCM ciphertext format", () => {
    const encrypted = encryptWebhookUrl(TEST_URL);
    expect(encrypted).toMatch(
      /^enc:v1:aes-256-gcm:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    );
    expect(encrypted).not.toContain("my_secret_token");
  });

  it("decrypts ciphertext back into the original URL", () => {
    const encrypted = encryptWebhookUrl(TEST_URL);
    const decrypted = decryptWebhookUrl(encrypted);
    expect(decrypted).toBe(TEST_URL);
  });

  it("handles legacy unencrypted plaintext URLs gracefully", () => {
    const plain = "https://hooks.slack.com/services/T000/B000/legacy";
    expect(decryptWebhookUrl(plain)).toBe(plain);
  });

  it("returns empty string on corrupted ciphertext without throwing", () => {
    expect(decryptWebhookUrl("enc:v1:aes-256-gcm:bad:payload:data")).toBe("");
  });
});

describe("buildChatAlertPayload", () => {
  const params = {
    repositoryFullName: "acme/secret-vault",
    count: 3,
    prNumber: 42,
    dashboardUrl: "https://secureflow.dev/dashboard",
  };

  it("formats a Slack Block Kit payload with repository, severity, count, and dashboard link", () => {
    const payload = buildChatAlertPayload("slack", params);
    expect(payload.text).toContain("3 New CRITICAL findings in acme/secret-vault #42");

    const jsonStr = JSON.stringify(payload);
    expect(jsonStr).toContain("acme/secret-vault");
    expect(jsonStr).toContain("CRITICAL");
    expect(jsonStr).toContain("3");
    expect(jsonStr).toContain("https://secureflow.dev/dashboard");

    // Strictly NO code snippets or secrets
    expect(jsonStr).not.toContain("codeSnippet");
    expect(jsonStr).not.toContain("password");
    expect(jsonStr).not.toContain("aws_secret_key");
  });

  it("formats a Discord embed payload with repository, severity, count, and dashboard link", () => {
    const payload = buildChatAlertPayload("discord", params);
    expect(payload.content).toContain("acme/secret-vault");
    expect(payload.content).toContain("CRITICAL");
    expect(payload.content).toContain("3");
    expect(payload.content).toContain("https://secureflow.dev/dashboard");

    const jsonStr = JSON.stringify(payload);
    expect(jsonStr).not.toContain("codeSnippet");
    expect(jsonStr).not.toContain("process.env");
  });
});

describe("sendChatAlert with retry and backoff", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers successfully on first attempt (200 OK)", async () => {
    const dispatchSpy = vi.spyOn(outbound, "dispatchOutboundWebhook").mockResolvedValue({
      status: 200,
      destination: "https://hooks.slack.com",
      deliveryId: "del-1",
      durationMs: 50,
      bodyPreview: '{"ok":true}',
    });

    const res = await sendChatAlert(
      "https://hooks.slack.com/services/T000/B000/XXXX",
      { repositoryFullName: "acme/repo", count: 1 },
      { initialBackoffMs: 1 },
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on transient 500 server error and succeeds on 2nd attempt", async () => {
    const dispatchSpy = vi
      .spyOn(outbound, "dispatchOutboundWebhook")
      .mockResolvedValueOnce({
        status: 500,
        destination: "https://discord.com",
        deliveryId: "del-1",
        durationMs: 50,
        bodyPreview: "Internal Server Error",
      })
      .mockResolvedValueOnce({
        status: 200,
        destination: "https://discord.com",
        deliveryId: "del-2",
        durationMs: 50,
        bodyPreview: "OK",
      });

    const res = await sendChatAlert(
      "https://discord.com/api/webhooks/123/token",
      { repositoryFullName: "acme/repo", count: 1 },
      { maxRetries: 3, initialBackoffMs: 5 },
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 429 rate limit", async () => {
    const dispatchSpy = vi
      .spyOn(outbound, "dispatchOutboundWebhook")
      .mockResolvedValueOnce({
        status: 429,
        destination: "https://hooks.slack.com",
        deliveryId: "del-1",
        durationMs: 50,
        bodyPreview: "Rate limited",
      })
      .mockResolvedValueOnce({
        status: 200,
        destination: "https://hooks.slack.com",
        deliveryId: "del-2",
        durationMs: 50,
        bodyPreview: "OK",
      });

    const res = await sendChatAlert(
      "https://hooks.slack.com/services/T000/B000/XXXX",
      { repositoryFullName: "acme/repo", count: 2 },
      { maxRetries: 3, initialBackoffMs: 5 },
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it("does not retry on permanent 400 Bad Request error", async () => {
    const dispatchSpy = vi.spyOn(outbound, "dispatchOutboundWebhook").mockResolvedValue({
      status: 400,
      destination: "https://hooks.slack.com",
      deliveryId: "del-1",
      durationMs: 50,
      bodyPreview: "Bad Request",
    });

    const res = await sendChatAlert(
      "https://hooks.slack.com/services/T000/B000/XXXX",
      { repositoryFullName: "acme/repo", count: 1 },
      { maxRetries: 3, initialBackoffMs: 5 },
    );

    expect(res.success).toBe(false);
    expect(res.attempts).toBe(1); // Exits immediately without retrying
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails gracefully without throwing when all retries are exhausted", async () => {
    vi.spyOn(outbound, "dispatchOutboundWebhook").mockResolvedValue({
      status: 503,
      destination: "https://discord.com",
      deliveryId: "del-1",
      durationMs: 50,
      bodyPreview: "Service Unavailable",
    });

    const res = await sendChatAlert(
      "https://discord.com/api/webhooks/123/token",
      { repositoryFullName: "acme/repo", count: 1 },
      { maxRetries: 2, initialBackoffMs: 5 },
    );

    expect(res.success).toBe(false);
    expect(res.attempts).toBe(2);
  });
});

describe("dispatchCriticalChatAlert (deduplication & new findings)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearInMemoryAlertedFindings();
    vi.spyOn(outbound, "dispatchOutboundWebhook").mockResolvedValue({
      status: 200,
      destination: "https://hooks.slack.com",
      deliveryId: "del-1",
      durationMs: 50,
      bodyPreview: "OK",
    });
  });

  it("does not alert when there are no CRITICAL findings", async () => {
    const res = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [
        { severity: "HIGH", fingerprint: "fp-high-1" },
        { severity: "MEDIUM", fingerprint: "fp-med-1" },
      ],
    });

    expect(res.alerted).toBe(false);
    expect(res.count).toBe(0);
    expect(mockFindUniqueUser).not.toHaveBeenCalled();
  });

  it("does not alert when user has no webhook configured", async () => {
    mockFindUniqueUser.mockResolvedValueOnce({
      chatWebhookUrl: null,
      slackWebhookUrl: null,
    });

    const res = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [{ severity: "CRITICAL", fingerprint: "fp-crit-1" }],
    });

    expect(res.alerted).toBe(false);
    expect(res.count).toBe(0);
  });

  it("alerts on a newly introduced critical finding", async () => {
    mockFindUniqueUser.mockResolvedValueOnce({
      chatWebhookUrl: encryptWebhookUrl("https://discord.com/api/webhooks/123/token"),
    });
    mockFindManyFindings.mockResolvedValueOnce([]); // No prior findings with this fingerprint

    const res = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      prNumber: 10,
      findings: [{ severity: "CRITICAL", fingerprint: "fp-crit-new" }],
    });

    expect(res.alerted).toBe(true);
    expect(res.count).toBe(1);
  });

  it("does not alert on findings already reported in previous scans", async () => {
    mockFindUniqueUser.mockResolvedValueOnce({
      chatWebhookUrl: encryptWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX"),
    });
    // Database returns that fp-crit-old was already reported in an earlier scan
    mockFindManyFindings.mockResolvedValueOnce([{ fingerprint: "fp-crit-old" }]);

    const res = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [{ severity: "CRITICAL", fingerprint: "fp-crit-old" }],
    });

    expect(res.alerted).toBe(false);
    expect(res.count).toBe(0);
  });

  it("alerts only on the newly introduced finding when mixed with an existing finding", async () => {
    mockFindUniqueUser.mockResolvedValueOnce({
      chatWebhookUrl: encryptWebhookUrl("https://discord.com/api/webhooks/123/token"),
    });
    // fp-crit-1 was already reported; fp-crit-2 is new
    mockFindManyFindings.mockResolvedValueOnce([{ fingerprint: "fp-crit-1" }]);

    const res = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [
        { severity: "CRITICAL", fingerprint: "fp-crit-1" },
        { severity: "CRITICAL", fingerprint: "fp-crit-2" },
      ],
    });

    expect(res.alerted).toBe(true);
    expect(res.count).toBe(1); // Only fp-crit-2 is alerted
  });

  it("sends exactly one alert across multiple duplicate runs (atomic deduplication)", async () => {
    mockFindUniqueUser.mockResolvedValue({
      chatWebhookUrl: encryptWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX"),
    });
    mockFindManyFindings.mockResolvedValue([]);

    // Run 1: First scan introduces fp-unique
    const res1 = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [{ severity: "CRITICAL", fingerprint: "fp-unique" }],
    });
    expect(res1.alerted).toBe(true);
    expect(res1.count).toBe(1);

    // Run 2: Push 2 or retry still contains fp-unique
    const res2 = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [{ severity: "CRITICAL", fingerprint: "fp-unique" }],
    });
    expect(res2.alerted).toBe(false);
    expect(res2.count).toBe(0);
  });

  it("fails safely without throwing when webhook request encounters an error", async () => {
    mockFindUniqueUser.mockResolvedValueOnce({
      chatWebhookUrl: encryptWebhookUrl("https://discord.com/api/webhooks/123/token"),
    });
    mockFindManyFindings.mockResolvedValueOnce([]);
    vi.spyOn(outbound, "dispatchOutboundWebhook").mockRejectedValue(new Error("Network timeout"));

    // Should resolve cleanly without throwing
    const res = await dispatchCriticalChatAlert({
      userId: "user-1",
      repositoryId: "repo-1",
      repositoryFullName: "acme/repo",
      findings: [{ severity: "CRITICAL", fingerprint: "fp-crit-err" }],
    });

    expect(res.alerted).toBe(false);
    expect(res.error).toBeDefined();
  });
});
