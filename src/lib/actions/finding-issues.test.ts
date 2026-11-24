import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFindingIssuePrefill, createIssueForFinding } from "./finding-issues";
import { REDACTION_PLACEHOLDER } from "@/lib/armor/secret-masking";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

const mockFindingFindFirst = vi.fn();
const mockFindingUpdate = vi.fn();
const mockAuditLogCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: {
    finding: {
      findFirst: (...args: unknown[]) => mockFindingFindFirst(...args),
      update: (...args: unknown[]) => mockFindingUpdate(...args),
    },
    auditLog: {
      create: (...args: unknown[]) => mockAuditLogCreate(...args),
    },
  },
}));

describe("Finding Issues Server Actions (#1987)", () => {
  const dummyFinding = {
    id: "f-123",
    type: "SECRET",
    severity: "HIGH",
    fileLocation: "src/server.ts",
    lineStart: 10,
    lineEnd: 15,
    codeSnippet: "const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';",
    explanation: "Hardcoded secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    remediation: "Use env var for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    issueUrl: null,
    scanResult: {
      policyDecision: "REVIEW_REQUIRED",
      pullRequest: {
        prNumber: 42,
        headSha: "abc123456",
        repository: {
          id: "repo-1",
          fullName: "org/repo",
          userId: "user-1",
        },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: {
        id: "user-1",
        roles: ["ADMIN"],
      },
    });
    mockFindingFindFirst.mockResolvedValue(dummyFinding);
    mockFindingUpdate.mockResolvedValue({
      ...dummyFinding,
      issueUrl: "https://github.com/org/repo/issues/100",
    });
    mockAuditLogCreate.mockResolvedValue({ id: "audit-1" });
  });

  describe("getFindingIssuePrefill", () => {
    it("returns prefilled title and body with secrets redacted", async () => {
      const res = await getFindingIssuePrefill("f-123");
      expect(res.ok).toBe(true);
      expect(res.alreadyCreated).toBe(false);
      expect(res.prefill?.title).toContain("[Security] HIGH: SECRET in src/server.ts");
      expect(res.prefill?.body).toContain("## Security Finding Details");
      expect(res.prefill?.body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
      expect(res.prefill?.body).toContain(REDACTION_PLACEHOLDER);
      expect(res.prefill?.body).not.toContain("const token =");
    });

    it("indicates if an issue was already created", async () => {
      mockFindingFindFirst.mockResolvedValue({
        ...dummyFinding,
        issueUrl: "https://github.com/org/repo/issues/99",
      });

      const res = await getFindingIssuePrefill("f-123");
      expect(res.ok).toBe(true);
      expect(res.alreadyCreated).toBe(true);
      expect(res.issueUrl).toBe("https://github.com/org/repo/issues/99");
    });
  });

  describe("createIssueForFinding", () => {
    it("prevents creating duplicate issues for the same finding", async () => {
      mockFindingFindFirst.mockResolvedValue({
        ...dummyFinding,
        issueUrl: "https://github.com/org/repo/issues/99",
      });

      const res = await createIssueForFinding("f-123");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("An issue has already been created for this finding");
      expect(mockFindingUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it("enforces role checks: rejects VIEWER role with a permission error", async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: "user-viewer",
          roles: ["VIEWER"],
        },
      });

      const res = await createIssueForFinding("f-123");
      expect(res.ok).toBe(false);
      expect(res.error).toContain(
        "Permission denied: Only triagers and admins can create GitHub issues for findings.",
      );
      expect(mockFindingUpdate).not.toHaveBeenCalled();
    });

    it("allows TRIAGER role to create issues", async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: "user-triager",
          roles: ["TRIAGER"],
        },
      });

      const mockCreate = vi.fn().mockResolvedValue({
        data: { html_url: "https://github.com/org/repo/issues/105", number: 105 },
      });

      const res = await createIssueForFinding("f-123", undefined, {
        octokitClient: { rest: { issues: { create: mockCreate } } },
      });

      expect(res.ok).toBe(true);
      expect(res.issueUrl).toBe("https://github.com/org/repo/issues/105");
      expect(res.issueNumber).toBe(105);
      expect(mockFindingUpdate).toHaveBeenCalledWith({
        where: { id: "f-123" },
        data: { issueUrl: "https://github.com/org/repo/issues/105" },
      });
    });

    it("successfully creates an issue, redacting secrets, updating finding, and logging audit entry", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        data: { html_url: "https://github.com/org/repo/issues/200", number: 200 },
      });

      const res = await createIssueForFinding(
        "f-123",
        {
          title: "Custom Title with secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
          body: "Custom Body with secret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        },
        { octokitClient: { rest: { issues: { create: mockCreate } } } },
      );

      expect(res.ok).toBe(true);
      expect(res.issueUrl).toBe("https://github.com/org/repo/issues/200");
      expect(res.issueNumber).toBe(200);

      // Verify GitHub issues.create received redacted content
      const [callArgs] = mockCreate.mock.calls;
      expect(callArgs[0].owner).toBe("org");
      expect(callArgs[0].repo).toBe("repo");
      expect(callArgs[0].title).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
      expect(callArgs[0].title).toContain(REDACTION_PLACEHOLDER);
      expect(callArgs[0].body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
      expect(callArgs[0].body).toContain(REDACTION_PLACEHOLDER);

      // Verify database update
      expect(mockFindingUpdate).toHaveBeenCalledWith({
        where: { id: "f-123" },
        data: { issueUrl: "https://github.com/org/repo/issues/200" },
      });

      // Verify audit log creation
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            action: "FINDING_ISSUE_CREATED",
            resource: "org/repo:f-123",
            metadata: expect.objectContaining({
              findingId: "f-123",
              issueUrl: "https://github.com/org/repo/issues/200",
              issueNumber: 200,
            }),
          }),
        }),
      );

      // Verify path revalidation
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/findings");
      expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/findings/f-123");
    });

    it("handles missing GitHub permission error cleanly with a descriptive message", async () => {
      const forbiddenError = Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
      });

      const mockCreate = vi.fn().mockRejectedValue(forbiddenError);

      const res = await createIssueForFinding("f-123", undefined, {
        octokitClient: { rest: { issues: { create: mockCreate } } },
      });

      expect(res.ok).toBe(false);
      expect(res.error).toBe(
        "The SecureFlow GitHub App lacks 'issues: write' permission on org/repo. Please grant 'Issues: Read and write' in the GitHub App settings.",
      );
      // Finding must NOT be updated when creation failed
      expect(mockFindingUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });
  });
});
