import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Server actions behind /dashboard/settings: saving and reading the user's
 * Slack webhook URL.
 */

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
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

import { getSlackWebhook, updateSlackWebhook } from "./settings";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

beforeEach(() => {
  vi.clearAllMocks();
  session = { user: { id: "user-1" } };
  mockUpdate.mockResolvedValue({});
  mockFindUnique.mockResolvedValue(null);
});

describe("updateSlackWebhook", () => {
  it("rejects callers without a session", async () => {
    session = null;
    await expect(updateSlackWebhook(WEBHOOK)).rejects.toThrow("Unauthorized");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a session that has no user id", async () => {
    session = { user: {} };
    await expect(updateSlackWebhook(WEBHOOK)).rejects.toThrow("Unauthorized");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a URL without writing anything", async () => {
    await expect(updateSlackWebhook("not a url")).rejects.toThrow(
      "Invalid Slack webhook URL format.",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("stores the trimmed URL for the signed-in user and revalidates the page", async () => {
    await expect(updateSlackWebhook(`  ${WEBHOOK}  `)).resolves.toEqual({ success: true });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { slackWebhookUrl: WEBHOOK },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/settings");
  });

  describe("SSRF security policy enforcement", () => {
    it.each([
      ["http scheme", "http://hooks.slack.com/services/T000/B000/XXXX"],
      ["ftp scheme", "ftp://hooks.slack.com/services/T000/B000/XXXX"],
      ["gopher scheme", "gopher://hooks.slack.com/services/T000/B000/XXXX"],
    ])("rejects invalid scheme: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["IPv4 loopback http", "http://127.0.0.1/"],
      ["IPv4 loopback https", "https://127.0.0.1/"],
      ["localhost http", "http://localhost/"],
      ["localhost https", "https://localhost/"],
      ["private 10.0.0.0/8", "https://10.0.0.1/"],
      ["private 172.16.0.0/12", "https://172.16.0.1/"],
      ["private 192.168.0.0/16", "https://192.168.1.1/"],
      ["cloud metadata 169.254.169.254", "https://169.254.169.254/"],
      ["IPv6 loopback", "https://[::1]/"],
      ["IPv6 link-local", "https://[fe80::1]/"],
    ])("rejects internal destination: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["arbitrary domain", "https://evil.example.com/services/T000/B000/XXXX"],
      ["subdomain suffix attack", "https://hooks.slack.com.evil.example/services/T000/B000/XXXX"],
      ["attacker subdomain on slack", "https://evil.hooks.slack.com/services/T000/B000/XXXX"],
    ])("rejects arbitrary public host: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["embedded credentials", "https://user:pass@hooks.slack.com/services/T000/B000/XXXX"],
      ["custom port", "https://hooks.slack.com:8080/services/T000/B000/XXXX"],
      ["query string", "https://hooks.slack.com/services/T000/B000/XXXX?query=1"],
      ["fragment", "https://hooks.slack.com/services/T000/B000/XXXX#fragment"],
    ])("rejects URL authority and parameter attacks: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ["root path", "https://hooks.slack.com/"],
      ["non-services path", "https://hooks.slack.com/not-services/T000/B000/XXXX"],
      ["api path", "https://hooks.slack.com/api/chat.postMessage"],
    ])("rejects invalid Slack path: %s", async (_label, url) => {
      await expect(updateSlackWebhook(url)).rejects.toThrow();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("clears the webhook when given %s", async (_label, value) => {
    await expect(updateSlackWebhook(value)).resolves.toEqual({ success: true });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { slackWebhookUrl: null },
    });
  });
});

describe("getSlackWebhook", () => {
  it("returns null without querying when there is no session", async () => {
    session = null;
    await expect(getSlackWebhook()).resolves.toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("reads only the webhook field for the signed-in user", async () => {
    mockFindUnique.mockResolvedValue({ slackWebhookUrl: WEBHOOK });

    await expect(getSlackWebhook()).resolves.toBe(WEBHOOK);
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { slackWebhookUrl: true },
    });
  });

  it("returns null when the user row is missing or has no webhook", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    await expect(getSlackWebhook()).resolves.toBeNull();

    mockFindUnique.mockResolvedValueOnce({ slackWebhookUrl: null });
    await expect(getSlackWebhook()).resolves.toBeNull();
  });
});
