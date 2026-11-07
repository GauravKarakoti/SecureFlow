import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  claimNotificationDispatch,
  buildBlockedSlackAlert,
  notifyBlockedScan,
  blockedScanDedupeKey,
} from "./notification-dispatcher";

// Mocks
const {
  mockPrismaUserFindUnique,
  mockPrismaAuditLogCreate,
  mockSendSlackAlert,
  mockSendTeamsAlert,
} = vi.hoisted(() => ({
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaAuditLogCreate: vi.fn(),
  mockSendSlackAlert: vi.fn(),
  mockSendTeamsAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findUnique: mockPrismaUserFindUnique,
    },
    auditLog: {
      create: mockPrismaAuditLogCreate,
    },
  },
}));

vi.mock("@/lib/integrations/slack", () => ({
  sendSlackAlert: mockSendSlackAlert,
}));

vi.mock("@/lib/integrations/teams", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/teams")>();
  return {
    ...actual,
    sendTeamsAlert: mockSendTeamsAlert,
  };
});

describe("claimNotificationDispatch (Deduplication)", () => {
  it("uses Redis SET NX to claim delivery and prevents duplicate dispatch", async () => {
    const mockRedis = {
      set: vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null),
    };

    const first = await claimNotificationDispatch("delivery-123", mockRedis as any);
    expect(first).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      blockedScanDedupeKey("delivery-123"),
      "1",
      "EX",
      86400,
      "NX",
    );

    const second = await claimNotificationDispatch("delivery-123", mockRedis as any);
    expect(second).toBe(false);
  });

  it("handles Redis outage gracefully by allowing dispatch", async () => {
    const mockRedis = {
      set: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
    };

    const allowed = await claimNotificationDispatch("delivery-456", mockRedis as any);
    expect(allowed).toBe(true);
  });
});

describe("buildBlockedSlackAlert", () => {
  it("generates a clean Slack alert payload without secrets or source code", () => {
    const alert = buildBlockedSlackAlert("octocat/Hello-World", 42, [
      { severity: "CRITICAL", type: "Secret Leak" },
      { severity: "HIGH", type: "RCE" },
    ]);

    expect(alert.text).toContain("octocat/Hello-World#42");
    expect(alert.text).toContain("BLOCKED");

    const json = JSON.stringify(alert);
    expect(json).not.toContain("codeSnippet");
    expect(json).not.toContain("token");
    expect(json).toContain("https://github.com/octocat/Hello-World/pull/42");
    expect(json).toContain("/dashboard");
  });
});

describe("notifyBlockedScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not send notifications if scan is not BLOCKED (e.g. PASS)", async () => {
    const result = await notifyBlockedScan({
      repositoryFullName: "acme/repo",
      prNumber: 1,
      findings: [],
      decision: "PASS",
    });

    expect(result.slackSent).toBe(false);
    expect(result.teamsSent).toBe(false);
    expect(mockSendSlackAlert).not.toHaveBeenCalled();
    expect(mockSendTeamsAlert).not.toHaveBeenCalled();
  });

  it("sends both Slack and Teams alerts and creates audit log records", async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({
      slackWebhookUrl: "https://hooks.slack.com/services/test",
      teamsWebhookUrl: "https://outlook.office.com/webhook/test",
    });

    mockSendSlackAlert.mockResolvedValueOnce(true);
    mockSendTeamsAlert.mockResolvedValueOnce(true);

    const result = await notifyBlockedScan({
      scanJobId: "job-1",
      deliveryId: "deliv-1",
      userId: "user-1",
      repositoryFullName: "acme/repo",
      prNumber: 5,
      findings: [{ severity: "CRITICAL" }],
      decision: "BLOCKED",
    });

    expect(result.slackSent).toBe(true);
    expect(result.teamsSent).toBe(true);
    expect(result.deduplicated).toBe(false);

    expect(mockSendSlackAlert).toHaveBeenCalledOnce();
    expect(mockSendTeamsAlert).toHaveBeenCalledOnce();

    // Verify audit logs were created
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledTimes(2);
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          action: "NOTIFICATION_DISPATCH_SLACK",
          resource: "acme/repo#5",
          decision: "SUCCESS",
        }),
      }),
    );
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          action: "NOTIFICATION_DISPATCH_TEAMS",
          resource: "acme/repo#5",
          decision: "SUCCESS",
        }),
      }),
    );
  });

  it("does not crash if webhook call rejects / fails", async () => {
    mockPrismaUserFindUnique.mockResolvedValueOnce({
      slackWebhookUrl: "https://hooks.slack.com/services/test",
      teamsWebhookUrl: "https://outlook.office.com/webhook/test",
    });

    mockSendSlackAlert.mockRejectedValueOnce(new Error("Slack down"));
    mockSendTeamsAlert.mockResolvedValueOnce(false);

    const result = await notifyBlockedScan({
      scanJobId: "job-1",
      deliveryId: "deliv-2",
      userId: "user-1",
      repositoryFullName: "acme/repo",
      prNumber: 5,
      findings: [{ severity: "CRITICAL" }],
      decision: "BLOCKED",
    });

    expect(result.slackSent).toBe(false);
    expect(result.teamsSent).toBe(false);
    // Audit logs recorded failures
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "NOTIFICATION_DISPATCH_SLACK",
          decision: "FAILURE",
        }),
      }),
    );
  });
});
