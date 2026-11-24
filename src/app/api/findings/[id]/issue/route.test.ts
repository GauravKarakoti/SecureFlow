import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/lib/actions/finding-issues", () => ({
  getFindingIssuePrefill: vi.fn(),
  createIssueForFinding: vi.fn(),
}));

import { getFindingIssuePrefill, createIssueForFinding } from "@/lib/actions/finding-issues";

describe("Finding Issue API Route (/api/findings/[id]/issue)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET handler", () => {
    it("returns prefill details when finding exists", async () => {
      vi.mocked(getFindingIssuePrefill).mockResolvedValue({
        ok: true,
        alreadyCreated: false,
        canCreate: true,
        prefill: {
          title: "Test Title",
          body: "Test Body",
          repositoryFullName: "acme/repo",
        },
      });

      const req = new NextRequest("http://localhost/api/findings/f-1/issue");
      const res = await GET(req, { params: Promise.resolve({ id: "f-1" }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.prefill.title).toBe("Test Title");
    });
  });

  describe("POST handler", () => {
    it("returns 201 on successful issue creation", async () => {
      vi.mocked(createIssueForFinding).mockResolvedValue({
        ok: true,
        issueUrl: "https://github.com/acme/repo/issues/42",
        issueNumber: 42,
      });

      const req = new NextRequest("http://localhost/api/findings/f-1/issue", {
        method: "POST",
        body: JSON.stringify({ title: "Custom Title", body: "Custom Body" }),
      });
      const res = await POST(req, { params: Promise.resolve({ id: "f-1" }) });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.issueUrl).toBe("https://github.com/acme/repo/issues/42");
    });

    it("returns 409 when an issue was already created (duplicate prevention)", async () => {
      vi.mocked(createIssueForFinding).mockResolvedValue({
        ok: false,
        error:
          "An issue has already been created for this finding: https://github.com/acme/repo/issues/42",
        issueUrl: "https://github.com/acme/repo/issues/42",
      });

      const req = new NextRequest("http://localhost/api/findings/f-1/issue", {
        method: "POST",
      });
      const res = await POST(req, { params: Promise.resolve({ id: "f-1" }) });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toContain("already been created");
    });
  });
});
