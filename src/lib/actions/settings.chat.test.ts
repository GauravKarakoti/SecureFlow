import { describe, it, expect, vi, beforeEach } from "vitest";

let session: { user: { id?: string } } | null = { user: { id: "user-1" } };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => session),
}));

const mockUpdate = vi.hoisted(() => vi.fn());
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockRevalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      update: mockUpdate,
      findUnique: mockFindUnique,
    },
    installationSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

import { updateChatWebhook, getChatWebhookStatus, testChatWebhook } from "./settings";
import * as chatIntegration from "@/lib/integrations/chat-webhook";

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
const DISCORD_URL = "https://discord.com/api/webhooks/1234567890/token_abc-123";

beforeEach(() => {
  vi.clearAllMocks();
  session = { user: { id: "user-1" } };
  mockUpdate.mockResolvedValue({});
  mockFindUnique.mockResolvedValue(null);
});

describe("updateChatWebhook", () => {
  it("rejects unauthenticated callers", async () => {
    session = null;
    await expect(updateChatWebhook(SLACK_URL)).rejects.toThrow("Unauthorized");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("stores Slack webhook URL encrypted at rest and revalidates settings", async () => {
    const res = await updateChatWebhook(SLACK_URL);
    expect(res).toEqual({ success: true, provider: "slack" });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        chatWebhookUrl: expect.stringMatching(/^enc:v1:aes-256-gcm:/),
      },
    });

    // Confirms plaintext token is not stored raw
    const savedData = mockUpdate.mock.calls[0][0].data.chatWebhookUrl;
    expect(savedData).not.toContain("XXXX");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
  });

  it("stores Discord webhook URL encrypted at rest", async () => {
    const res = await updateChatWebhook(DISCORD_URL);
    expect(res).toEqual({ success: true, provider: "discord" });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        chatWebhookUrl: expect.stringMatching(/^enc:v1:aes-256-gcm:/),
      },
    });

    const savedData = mockUpdate.mock.calls[0][0].data.chatWebhookUrl;
    expect(savedData).not.toContain("token_abc-123");
  });

  it("clears chat webhook when given null or empty string", async () => {
    await expect(updateChatWebhook(null)).resolves.toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { chatWebhookUrl: null },
    });

    await expect(updateChatWebhook("")).resolves.toEqual({ success: true });
    await expect(updateChatWebhook("   ")).resolves.toEqual({ success: true });
  });

  it("rejects invalid or SSRF webhook URLs", async () => {
    await expect(updateChatWebhook("http://hooks.slack.com/services/XXX")).rejects.toThrow(
      /only https is allowed/,
    );
    await expect(updateChatWebhook("https://127.0.0.1/services/XXX")).rejects.toThrow(
      /only Slack.*or Discord/,
    );
    await expect(updateChatWebhook("https://evil.com/webhook")).rejects.toThrow(
      /only Slack.*or Discord/,
    );
  });
});

describe("getChatWebhookStatus", () => {
  it("returns not configured when user has no session", async () => {
    session = null;
    const status = await getChatWebhookStatus();
    expect(status).toEqual({ isConfigured: false, provider: null, maskedUrl: null });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("returns masked URL and provider without ever exposing the raw secret URL", async () => {
    const encryptedDiscord = chatIntegration.encryptWebhookUrl(DISCORD_URL);
    mockFindUnique.mockResolvedValueOnce({ chatWebhookUrl: encryptedDiscord });

    const status = await getChatWebhookStatus();
    expect(status.isConfigured).toBe(true);
    expect(status.provider).toBe("discord");
    expect(status.maskedUrl).toBe("https://discord.com/api/webhooks/1234567890/••••••••");

    // Strictly never exposes the token
    expect(status.maskedUrl).not.toContain("token_abc-123");
  });

  it("returns not configured when user has no stored webhook", async () => {
    mockFindUnique.mockResolvedValueOnce({ chatWebhookUrl: null, slackWebhookUrl: null });
    const status = await getChatWebhookStatus();
    expect(status).toEqual({ isConfigured: false, provider: null, maskedUrl: null });
  });
});

describe("testChatWebhook", () => {
  it("rejects unauthenticated requests", async () => {
    session = null;
    await expect(testChatWebhook(SLACK_URL)).rejects.toThrow("Unauthorized");
  });

  it("sends test alert with provided URL", async () => {
    const sendSpy = vi.spyOn(chatIntegration, "sendChatAlert").mockResolvedValueOnce({
      success: true,
      attempts: 1,
    });

    const res = await testChatWebhook(DISCORD_URL);
    expect(res.success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(DISCORD_URL, {
      repositoryFullName: "SecureFlow/test-repository",
      count: 1,
      prNumber: 1,
    });
  });

  it("sends test alert using stored webhook URL when none is explicitly passed", async () => {
    mockFindUnique.mockResolvedValueOnce({
      chatWebhookUrl: chatIntegration.encryptWebhookUrl(SLACK_URL),
    });

    const sendSpy = vi.spyOn(chatIntegration, "sendChatAlert").mockResolvedValueOnce({
      success: true,
      attempts: 1,
    });

    const res = await testChatWebhook();
    expect(res.success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(SLACK_URL, expect.any(Object));
  });

  it("returns error when no webhook URL is configured and none passed", async () => {
    mockFindUnique.mockResolvedValueOnce({ chatWebhookUrl: null, slackWebhookUrl: null });
    const res = await testChatWebhook();
    expect(res.success).toBe(false);
    expect(res.error).toContain("No webhook URL configured");
  });
});
