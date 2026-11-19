import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildFindingCreatedPayload,
  buildFindingDismissedPayload,
  buildScanBlockedPayload,
  buildScanCompletedPayload,
  deliverOutboundWebhook,
  dispatchOutboundWebhooksForUser,
  sanitizeFindingForOutboundPayload,
} from "./outbound-dispatcher";
import { verifyOutboundWebhookSignature } from "./outbound-signature";

// Mock Prisma
const mockDeliveryCreate = vi.fn();
const mockWebhookFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: {
    outboundWebhookDelivery: {
      create: (...args: any[]) => mockDeliveryCreate(...args),
    },
    outboundWebhook: {
      findMany: (...args: any[]) => mockWebhookFindMany(...args),
    },
  },
}));

describe("Outbound Webhook Dispatcher & Zero-Leakage Payloads (#1866)", () => {
  const secret = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const fakeWebhook = {
    id: "wh_123",
    url: "https://siem.corp-security.com/hooks/secureflow",
    secret,
  };
  const mockDnsPublic = async () => ["93.184.216.34"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Zero-Leakage Payload Builders", () => {
    it("scrubs code snippets, diffs, and secret contents from findings", () => {
      const dirtyFinding = {
        id: "find_1",
        type: "HARDCODED_SECRET",
        severity: "CRITICAL",
        fileLocation: "config/auth.ts",
        lineStart: 12,
        lineEnd: 15,
        fingerprint: "fp_abc123",
        // Sensitive fields that must NOT leak
        codeSnippet: 'const apiKey = "sk_live_SECRET_DO_NOT_LEAK";',
        secretValue: "sk_live_SECRET_DO_NOT_LEAK",
        diff: '+ const apiKey = "sk_live_SECRET_DO_NOT_LEAK";',
        rawPatch: '@@ -10,3 +10,4 @@ const token = "abc";',
      };

      const sanitized = sanitizeFindingForOutboundPayload(dirtyFinding as any);

      expect(sanitized).toEqual({
        id: "find_1",
        type: "HARDCODED_SECRET",
        severity: "CRITICAL",
        fileLocation: "config/auth.ts",
        lineStart: 12,
        lineEnd: 15,
        fingerprint: "fp_abc123",
      });

      expect(JSON.stringify(sanitized)).not.toContain("sk_live_SECRET_DO_NOT_LEAK");
      expect(JSON.stringify(sanitized)).not.toContain("codeSnippet");
      expect(JSON.stringify(sanitized)).not.toContain("diff");
    });

    it("builds clean scan.completed and scan.blocked payloads with severity breakdown", () => {
      const findings = [
        {
          id: "f1",
          type: "SQL_INJECTION",
          severity: "CRITICAL",
          fileLocation: "db.ts",
          secret: "password123",
        },
        { id: "f2", type: "XSS", severity: "HIGH", fileLocation: "ui.tsx", snippet: "<script>" },
      ];

      const completed = buildScanCompletedPayload({
        repository: "acme/backend",
        prNumber: 42,
        commitSha: "sha_xyz123",
        decision: "PASS",
        findings: findings as any,
      });

      expect(completed.event).toBe("scan.completed");
      expect(completed.id).toMatch(/^evt_/);
      expect(completed.data.repository).toBe("acme/backend");
      expect(completed.data.prNumber).toBe(42);
      expect(completed.data.decision).toBe("PASS");
      expect(completed.data.totalFindings).toBe(2);
      expect(completed.data.severityCounts).toEqual({
        CRITICAL: 1,
        HIGH: 1,
        MEDIUM: 0,
        LOW: 0,
      });

      const serialized = JSON.stringify(completed);
      expect(serialized).not.toContain("password123");
      expect(serialized).not.toContain("<script>");

      const blocked = buildScanBlockedPayload({
        repository: "acme/backend",
        prNumber: 42,
        commitSha: "sha_xyz123",
        decision: "BLOCKED",
        findings: findings as any,
      });

      expect(blocked.event).toBe("scan.blocked");
      expect(blocked.data.decision).toBe("BLOCKED");
    });

    it("builds finding.created and finding.dismissed payloads with zero leak", () => {
      const created = buildFindingCreatedPayload({
        repository: "acme/backend",
        prNumber: 42,
        commitSha: "sha_xyz123",
        finding: {
          id: "f1",
          type: "SSRF",
          severity: "HIGH",
          fileLocation: "proxy.ts",
        },
      });

      expect(created.event).toBe("finding.created");
      expect(created.data.repository).toBe("acme/backend");
      expect((created.data.finding as any).type).toBe("SSRF");

      const dismissed = buildFindingDismissedPayload({
        repository: "acme/backend",
        fingerprint: "fp_999",
        status: "DISMISSED",
        reason: "FALSE_POSITIVE",
        dismissedAt: "2026-11-19T18:00:00.000Z",
      });

      expect(dismissed.event).toBe("finding.dismissed");
      expect(dismissed.data.repository).toBe("acme/backend");
      expect(dismissed.data.status).toBe("DISMISSED");
      expect(dismissed.data.reason).toBe("FALSE_POSITIVE");
    });
  });

  describe("deliverOutboundWebhook (SSRF guard, signing & retries)", () => {
    it("blocks delivery immediately if endpoint resolves to loopback/private IP without sending HTTP request", async () => {
      const mockFetch = vi.fn();
      const mockDnsPrivate = async () => ["127.0.0.1"];

      const res = await deliverOutboundWebhook(
        fakeWebhook,
        buildScanCompletedPayload({
          repository: "acme/repo",
          prNumber: 1,
          commitSha: "sha1",
          decision: "PASS",
          findings: [],
        }),
        {
          fetchFn: mockFetch as any,
          dnsLookup: mockDnsPrivate,
          initialBackoffMs: 0,
        },
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain("resolves to a blocked or private IP address");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockDeliveryCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            webhookId: "wh_123",
            statusCode: null,
            error: expect.stringContaining("resolves to a blocked or private IP address"),
            deliveredAt: null,
          }),
        }),
      );
    });

    it("delivers signed payload on first attempt when server returns HTTP 200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      const envelope = buildScanCompletedPayload({
        repository: "acme/repo",
        prNumber: 1,
        commitSha: "sha1",
        decision: "PASS",
        findings: [],
      });

      const res = await deliverOutboundWebhook(fakeWebhook, envelope, {
        fetchFn: mockFetch as any,
        dnsLookup: mockDnsPublic,
        initialBackoffMs: 0,
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.attempts).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify request headers and signature
      const [url, requestInit] = mockFetch.mock.calls[0];
      expect(url).toBe(fakeWebhook.url);
      expect(requestInit.method).toBe("POST");

      const sentHeaders = requestInit.headers;
      const sentSignature = sentHeaders["X-SecureFlow-Signature"];
      const sentEventId = sentHeaders["X-SecureFlow-Event-Id"];
      const sentTimestamp = sentHeaders["X-SecureFlow-Timestamp"];

      expect(sentEventId).toBe(envelope.id);
      expect(sentTimestamp).toBe(envelope.timestamp);

      // Verify signature validity
      const sigVerification = verifyOutboundWebhookSignature({
        payload: requestInit.body,
        signature: sentSignature,
        secret: fakeWebhook.secret,
      });
      expect(sigVerification.valid).toBe(true);

      expect(mockDeliveryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          webhookId: "wh_123",
          eventId: envelope.id,
          statusCode: 200,
          error: null,
          attempts: 1,
          deliveredAt: expect.any(Date),
        }),
      });
    });

    it("retries with backoff on failure and succeeds on second attempt", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
        });

      const envelope = buildScanCompletedPayload({
        repository: "acme/repo",
        prNumber: 1,
        commitSha: "sha1",
        decision: "PASS",
        findings: [],
      });

      const res = await deliverOutboundWebhook(fakeWebhook, envelope, {
        fetchFn: mockFetch as any,
        dnsLookup: mockDnsPublic,
        maxAttempts: 3,
        initialBackoffMs: 1,
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res.attempts).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      expect(mockDeliveryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          webhookId: "wh_123",
          statusCode: 200,
          attempts: 2,
          deliveredAt: expect.any(Date),
        }),
      });
    });

    it("retries up to maxAttempts on persistent network/server errors and logs failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const envelope = buildScanCompletedPayload({
        repository: "acme/repo",
        prNumber: 1,
        commitSha: "sha1",
        decision: "PASS",
        findings: [],
      });

      const res = await deliverOutboundWebhook(fakeWebhook, envelope, {
        fetchFn: mockFetch as any,
        dnsLookup: mockDnsPublic,
        maxAttempts: 3,
        initialBackoffMs: 1,
      });

      expect(res.success).toBe(false);
      expect(res.attempts).toBe(3);
      expect(res.error).toBe("Connection refused");
      expect(mockFetch).toHaveBeenCalledTimes(3);

      expect(mockDeliveryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          webhookId: "wh_123",
          statusCode: null,
          error: "Connection refused",
          attempts: 3,
          deliveredAt: null,
        }),
      });
    });
  });

  describe("dispatchOutboundWebhooksForUser", () => {
    it("dispatches only to enabled endpoints subscribed to the matching event", async () => {
      mockWebhookFindMany.mockResolvedValueOnce([
        {
          id: "wh_1",
          url: "https://siem.example.com/events",
          secret,
          events: ["scan.completed", "scan.blocked"],
        },
        {
          id: "wh_2",
          url: "https://jira.example.com/webhook",
          secret,
          events: ["finding.created"], // Not subscribed to scan.completed
        },
      ]);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const results = await dispatchOutboundWebhooksForUser(
        "user_123",
        "scan.completed",
        () =>
          buildScanCompletedPayload({
            repository: "acme/repo",
            prNumber: 5,
            commitSha: "c1",
            decision: "PASS",
            findings: [],
          }),
        {
          fetchFn: mockFetch as any,
          dnsLookup: mockDnsPublic,
          initialBackoffMs: 0,
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].webhookId).toBe("wh_1");
      expect(results[0].success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when user has no matching webhooks", async () => {
      mockWebhookFindMany.mockResolvedValueOnce([]);

      const results = await dispatchOutboundWebhooksForUser(
        "user_none",
        "scan.completed",
        () =>
          buildScanCompletedPayload({
            repository: "acme/repo",
            prNumber: 5,
            commitSha: "c1",
            decision: "PASS",
            findings: [],
          }),
      );

      expect(results).toEqual([]);
    });
  });
});
