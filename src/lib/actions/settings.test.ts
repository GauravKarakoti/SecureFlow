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
    await expect(updateSlackWebhook("not a url")).rejects.toThrow("Invalid URL format");
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
