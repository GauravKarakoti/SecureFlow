import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertTeamsWebhookUrl, buildTeamsAlert, sendTeamsAlert } from "./teams";
import type { TeamsFindingSummary } from "./teams";

// Mock dispatchOutboundWebhook
const { mockDispatchOutboundWebhook } = vi.hoisted(() => ({
  mockDispatchOutboundWebhook: vi.fn(),
}));

vi.mock("@/lib/queue/outbound-dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queue/outbound-dispatch")>();
  return {
    ...actual,
    dispatchOutboundWebhook: mockDispatchOutboundWebhook,
  };
});

describe("assertTeamsWebhookUrl", () => {
  it("accepts valid Microsoft Teams webhook URLs", () => {
    const validUrls = [
      "https://outlook.office.com/webhook/test-uuid/IncomingWebhook/abc",
      "https://subdomain.webhook.office.com/webhookb2/guid",
      "https://prod.logic.azure.com/workflows/guid/triggers/manual/paths/invoke",
    ];

    for (const url of validUrls) {
      expect(assertTeamsWebhookUrl(url).toString()).toContain("https://");
    }
  });

  it("rejects non-https URLs", () => {
    expect(() => assertTeamsWebhookUrl("http://outlook.office.com/webhook")).toThrow(
      /only https is allowed/,
    );
  });

  it("rejects untrusted domains", () => {
    expect(() => assertTeamsWebhookUrl("https://evil.attacker.com/webhook")).toThrow(
      /only official Microsoft Teams/,
    );
  });

  it("rejects empty or missing URL", () => {
    expect(() => assertTeamsWebhookUrl("")).toThrow(/is missing/);
  });
});

describe("buildTeamsAlert", () => {
  it("formats MessageCard payload correctly without secret values or code snippets", () => {
    const findings: TeamsFindingSummary[] = [
      { severity: "CRITICAL", type: "Hardcoded Secret" },
      { severity: "HIGH", type: "SQL Injection" },
      { severity: "HIGH", type: "Command Injection" },
    ];

    const card = buildTeamsAlert({
      repositoryFullName: "acme/backend-service",
      prNumber: 42,
      findings,
      dashboardUrl: "https://secureflow.dev/dashboard",
    });

    expect(card["@type"]).toBe("MessageCard");
    expect(card.title).toContain("BLOCKED");
    expect(card.summary).toContain("acme/backend-service#42");

    const section = card.sections[0];
    expect(section.facts).toEqual(
      expect.arrayContaining([
        { name: "Repository", value: "acme/backend-service" },
        { name: "Pull Request", value: "#42" },
        { name: "CRITICAL Findings", value: "1" },
        { name: "HIGH Findings", value: "2" },
      ]),
    );

    // Verify actions have links
    const actions = card.potentialAction!;
    expect(actions[0].targets[0].uri).toBe("https://github.com/acme/backend-service/pull/42");
    expect(actions[1].targets[0].uri).toBe("https://secureflow.dev/dashboard");

    // Strictly ensure no secrets or snippets are accidentally contained
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain("codeSnippet");
    expect(cardStr).not.toContain("rawSecret");
  });
});

describe("sendTeamsAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends payload via dispatchOutboundWebhook and returns true on success", async () => {
    mockDispatchOutboundWebhook.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: Buffer.from("1"),
    });

    const card = buildTeamsAlert({
      repositoryFullName: "acme/repo",
      prNumber: 10,
      findings: [{ severity: "CRITICAL" }],
    });

    const ok = await sendTeamsAlert("https://outlook.office.com/webhook/test", card);
    expect(ok).toBe(true);
    expect(mockDispatchOutboundWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://outlook.office.com/webhook/test",
      }),
      expect.anything(),
    );
  });

  it("handles failure gracefully and returns false without throwing", async () => {
    mockDispatchOutboundWebhook.mockRejectedValueOnce(new Error("Network timeout"));

    const card = buildTeamsAlert({
      repositoryFullName: "acme/repo",
      prNumber: 10,
      findings: [{ severity: "CRITICAL" }],
    });

    const ok = await sendTeamsAlert("https://outlook.office.com/webhook/test", card);
    expect(ok).toBe(false);
  });
});
