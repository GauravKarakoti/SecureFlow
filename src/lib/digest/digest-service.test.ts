import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { MockMailTransport } from "@/lib/email/mail-transport";
import {
  generateWeeklyDigestForUser,
  generateAllWeeklyDigests,
  calculateDigestMetricsForUser,
  SEVEN_DAYS_MS,
} from "./digest-service";
import { renderDigestText, renderDigestHtml } from "./email-template";

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    repository: {
      findMany: vi.fn(),
    },
    finding: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    findingTriage: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    pullRequest: {
      count: vi.fn(),
    },
    securityDigest: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe("Weekly Security Digest Service (#1788)", () => {
  const fixedNow = new Date("2026-11-17T12:00:00.000Z");
  let mockTransport: MockMailTransport;

  const mockUserOptedIn = {
    id: "user-1",
    name: "Alex Vance",
    email: "alex@secureflow.dev",
    codename: "GHOST_99",
    weeklyDigestEnabled: true,
  };

  const mockUserOptedOut = {
    id: "user-2",
    name: "Gordon Freeman",
    email: "gordon@secureflow.dev",
    codename: "LAMBDA_1",
    weeklyDigestEnabled: false,
  };

  const mockRepositories = [
    { id: "repo-1", name: "auth-gateway", fullName: "SecureFlow/auth-gateway" },
    { id: "repo-2", name: "payment-api", fullName: "SecureFlow/payment-api" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = new MockMailTransport();

    // Default mocks
    (prisma.user.findUnique as any).mockResolvedValue(mockUserOptedIn);
    (prisma.repository.findMany as any).mockResolvedValue(mockRepositories);
    (prisma.finding.count as any).mockResolvedValue(8);
    (prisma.findingTriage.count as any)
      .mockResolvedValueOnce(3) // dismissed
      .mockResolvedValueOnce(4); // resolved
    (prisma.pullRequest.count as any).mockResolvedValue(2); // blocked PRs

    (prisma.findingTriage.findMany as any).mockResolvedValue([
      { repositoryId: "repo-1", fingerprint: "fp-resolved-1" },
    ]);

    (prisma.finding.findMany as any)
      .mockResolvedValueOnce([
        { fingerprint: "fp-open-1" },
        { fingerprint: "fp-open-2" },
        { fingerprint: "fp-resolved-1" },
      ]) // repo-1 findings
      .mockResolvedValueOnce([{ fingerprint: "fp-open-3" }]) // repo-2 findings
      .mockResolvedValueOnce([
        { type: "SQL_INJECTION" },
        { type: "SQL_INJECTION" },
        { type: "HARDCODED_SECRET" },
        { type: "INSECURE_CORS" },
      ]); // finding types in period

    (prisma.securityDigest.create as any).mockImplementation(({ data }: any) => ({
      id: "digest-101",
      ...data,
      createdAt: fixedNow,
    }));

    (prisma.securityDigest.update as any).mockImplementation(({ data }: any) => ({
      id: "digest-101",
      sentAt: fixedNow,
      ...data,
    }));
  });

  describe("Fixed Clock & Generation Logic", () => {
    it("generates and stores a weekly digest with the exact 7-day period using a fixed clock", async () => {
      (prisma.securityDigest.findFirst as any).mockResolvedValue(null);

      const result = await generateWeeklyDigestForUser("user-1", {
        now: fixedNow,
        mailTransport: mockTransport,
      });

      expect(result.success).toBe(true);
      expect(result.digest).toBeDefined();

      const expectedStart = new Date(fixedNow.getTime() - SEVEN_DAYS_MS);
      expect(prisma.securityDigest.create).toHaveBeenCalledWith({
        data: {
          userId: "user-1",
          startDate: expectedStart,
          endDate: fixedNow,
          newFindingsCount: 8,
          dismissedFindingsCount: 3,
          resolvedFindingsCount: 4,
          blockedPrsCount: 2,
          topRepositories: [
            { repositoryId: "repo-1", name: "SecureFlow/auth-gateway", openCount: 2 },
            { repositoryId: "repo-2", name: "SecureFlow/payment-api", openCount: 1 },
          ],
          topFindingTypes: [
            { type: "SQL_INJECTION", count: 2 },
            { type: "HARDCODED_SECRET", count: 1 },
            { type: "INSECURE_CORS", count: 1 },
          ],
        },
      });
    });

    it("enforces once-per-week rate limit and skips if already generated within 7 days", async () => {
      const recentDigest = {
        id: "digest-past",
        createdAt: new Date(fixedNow.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      };
      (prisma.securityDigest.findFirst as any).mockResolvedValue(recentDigest);

      const result = await generateWeeklyDigestForUser("user-1", {
        now: fixedNow,
        mailTransport: mockTransport,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("already_generated");
      expect(prisma.securityDigest.create).not.toHaveBeenCalled();
      expect(mockTransport.sentEmails).toHaveLength(0);
    });

    it("allows re-generating within 7 days when force: true is passed", async () => {
      const recentDigest = {
        id: "digest-past",
        createdAt: new Date(fixedNow.getTime() - 2 * 24 * 60 * 60 * 1000),
      };
      (prisma.securityDigest.findFirst as any).mockResolvedValue(recentDigest);

      const result = await generateWeeklyDigestForUser("user-1", {
        now: fixedNow,
        mailTransport: mockTransport,
        force: true,
      });

      expect(result.success).toBe(true);
      expect(prisma.securityDigest.create).toHaveBeenCalled();
      expect(mockTransport.sentEmails).toHaveLength(1);
    });
  });

  describe("Opt-Out Criteria Enforcement", () => {
    it("skips generation and delivers nothing if user has opted out (weeklyDigestEnabled: false)", async () => {
      (prisma.user.findUnique as any).mockResolvedValue(mockUserOptedOut);

      const result = await generateWeeklyDigestForUser("user-2", {
        now: fixedNow,
        mailTransport: mockTransport,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("opted_out");
      expect(prisma.securityDigest.create).not.toHaveBeenCalled();
      expect(mockTransport.sentEmails).toHaveLength(0);
    });

    it("batch generation filters out opted-out users", async () => {
      (prisma.user.findMany as any).mockResolvedValue([{ id: "user-1" }]);
      (prisma.securityDigest.findFirst as any).mockResolvedValue(null);

      const batchResult = await generateAllWeeklyDigests({
        now: fixedNow,
        mailTransport: mockTransport,
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { weeklyDigestEnabled: true },
        select: { id: true },
      });
      expect(batchResult.generated).toBe(1);
      expect(batchResult.skipped).toBe(0);
    });
  });

  describe("Mocked Mail Transport Delivery", () => {
    it("dispatches digest email to user and updates sentAt timestamp", async () => {
      (prisma.securityDigest.findFirst as any).mockResolvedValue(null);

      const result = await generateWeeklyDigestForUser("user-1", {
        now: fixedNow,
        mailTransport: mockTransport,
      });

      expect(result.emailSent).toBe(true);
      expect(mockTransport.sentEmails).toHaveLength(1);

      const sent = mockTransport.getLastEmail();
      expect(sent).toBeDefined();
      expect(sent?.to).toBe("alex@secureflow.dev");
      expect(sent?.subject).toContain("SecureFlow Weekly Security Digest");
      expect(sent?.text).toContain("EXECUTIVE SUMMARY");
      expect(sent?.text).toContain("New Findings Detected:       8");
      expect(sent?.text).toContain("Blocked Pull Requests:       2");
      expect(sent?.html).toContain("Alex Vance");
      expect(sent?.html).toContain("auth-gateway");
      expect(prisma.securityDigest.update).toHaveBeenCalledWith({
        where: { id: "digest-101" },
        data: { sentAt: fixedNow },
      });
    });

    it("does not send email if user has no email address configured", async () => {
      (prisma.user.findUnique as any).mockResolvedValue({
        ...mockUserOptedIn,
        email: null,
      });
      (prisma.securityDigest.findFirst as any).mockResolvedValue(null);

      const result = await generateWeeklyDigestForUser("user-1", {
        now: fixedNow,
        mailTransport: mockTransport,
      });

      expect(result.success).toBe(true);
      expect(result.emailSent).toBe(false);
      expect(mockTransport.sentEmails).toHaveLength(0);
    });
  });

  describe("Security: No Snippets or Secrets Leaked (#1788)", () => {
    it("never includes code snippets or secret tokens in rendered email templates", () => {
      const digestData = {
        startDate: "2026-11-10T12:00:00.000Z",
        endDate: "2026-11-17T12:00:00.000Z",
        newFindingsCount: 5,
        dismissedFindingsCount: 2,
        resolvedFindingsCount: 1,
        blockedPrsCount: 3,
        topRepositories: [{ repositoryId: "repo-1", name: "SecureFlow/core", openCount: 10 }],
        topFindingTypes: [{ type: "HARDCODED_API_KEY", count: 4 }],
      };

      const user = {
        name: "Operator Zero",
        codename: "OP_ZERO",
        email: "op@secureflow.dev",
      };

      const text = renderDigestText(digestData, user);
      const html = renderDigestHtml(digestData, user);

      // Verify absence of sensitive patterns
      const sensitivePatterns = [
        /const apiKey\s*=/i,
        /password\s*[:=]/i,
        /SELECT\s+\*\s+FROM/i,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        /ghp_[a-zA-Z0-9]{30,}/,
        /<script\b/i,
      ];

      for (const pattern of sensitivePatterns) {
        expect(text).not.toMatch(pattern);
        expect(html).not.toMatch(pattern);
      }

      expect(text).toContain("HARDCODED_API_KEY");
      expect(html).toContain("SecureFlow/core");
    });
  });
});
