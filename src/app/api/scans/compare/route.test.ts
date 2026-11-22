import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { authMock, pullRequestFindUniqueMock, scanResultFindUniqueMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  pullRequestFindUniqueMock: vi.fn(),
  scanResultFindUniqueMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  default: {
    pullRequest: {
      findUnique: pullRequestFindUniqueMock,
    },
    scanResult: {
      findUnique: scanResultFindUniqueMock,
    },
  },
}));

import { GET } from "./route";

function makeRequest(url: string) {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("GET /api/scans/compare (#1923)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-123" } });
  });

  it("returns 401 when user is not authenticated", async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await GET(makeRequest("/api/scans/compare?pullRequestId=pr-1"));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 400 when neither pullRequestId nor scan IDs are provided", async () => {
    const res = await GET(makeRequest("/api/scans/compare"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("required");
  });

  it("returns 404 when pull request is not found", async () => {
    pullRequestFindUniqueMock.mockResolvedValueOnce(null);

    const res = await GET(makeRequest("/api/scans/compare?pullRequestId=pr-missing"));
    expect(res.status).toBe(404);
  });

  it("returns 403 when user does not have access to the repository", async () => {
    pullRequestFindUniqueMock.mockResolvedValueOnce({
      id: "pr-1",
      prNumber: 42,
      title: "Feature",
      repository: { id: "repo-1", fullName: "acme/api", userId: "other-user" },
      scans: [],
    });

    const res = await GET(makeRequest("/api/scans/compare?pullRequestId=pr-1"));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("do not have access");
  });

  it("returns isComparable: false when PR has fewer than 2 scans", async () => {
    pullRequestFindUniqueMock.mockResolvedValueOnce({
      id: "pr-1",
      prNumber: 42,
      title: "Feature",
      repository: { id: "repo-1", fullName: "acme/api", userId: "user-123" },
      scans: [
        {
          id: "scan-1",
          headSha: "sha1",
          createdAt: new Date(),
          riskScore: 10,
          policyDecision: "PASS",
          findings: [],
        },
      ],
    });

    const res = await GET(makeRequest("/api/scans/compare?pullRequestId=pr-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isComparable).toBe(false);
    expect(json.incomparableReason).toContain("At least two scans");
    expect(json.scans).toHaveLength(1);
  });

  it("returns isComparable: false with clear message when a scan is partial", async () => {
    const scanLatest = {
      id: "scan-2",
      headSha: "sha2",
      createdAt: new Date("2026-11-22T10:00:00Z"),
      riskScore: 10,
      policyDecision: "PASS",
      gateConfig: { isPartialScan: true, skippedFiles: ["large.ts"] },
      findings: [],
    };
    const scanPrev = {
      id: "scan-1",
      headSha: "sha1",
      createdAt: new Date("2026-11-22T09:00:00Z"),
      riskScore: 10,
      policyDecision: "PASS",
      findings: [],
    };

    pullRequestFindUniqueMock.mockResolvedValueOnce({
      id: "pr-1",
      prNumber: 42,
      title: "Feature",
      repository: { id: "repo-1", fullName: "acme/api", userId: "user-123" },
      scans: [scanLatest, scanPrev],
    });

    const res = await GET(makeRequest("/api/scans/compare?pullRequestId=pr-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isComparable).toBe(false);
    expect(json.incomparableReason).toContain("partial scan");
  });

  it("successfully compares the latest two scans when no specific scan IDs are requested", async () => {
    const f1 = {
      id: "f-1",
      fingerprint: "fp-fixed",
      type: "Secret",
      severity: "CRITICAL",
      fileLocation: "src/secret.ts",
    };
    const f2 = {
      id: "f-2",
      fingerprint: "fp-unchanged",
      type: "Vulnerability",
      severity: "HIGH",
      fileLocation: "src/api.ts",
    };
    const f3 = {
      id: "f-3",
      fingerprint: "fp-unchanged",
      type: "Vulnerability",
      severity: "HIGH",
      fileLocation: "src/api.ts",
    };
    const f4 = {
      id: "f-4",
      fingerprint: "fp-new",
      type: "Misconfig",
      severity: "MEDIUM",
      fileLocation: "Dockerfile",
    };

    const scanPrev = {
      id: "scan-1",
      headSha: "sha1",
      createdAt: new Date("2026-11-22T08:00:00Z"),
      riskScore: 25,
      policyDecision: "BLOCK",
      findings: [f1, f2],
    };

    const scanLatest = {
      id: "scan-2",
      headSha: "sha2",
      createdAt: new Date("2026-11-22T09:00:00Z"),
      riskScore: 15,
      policyDecision: "REVIEW",
      findings: [f3, f4],
    };

    pullRequestFindUniqueMock.mockResolvedValueOnce({
      id: "pr-1",
      prNumber: 42,
      title: "Fix auth secret leak",
      repository: { id: "repo-1", fullName: "acme/api", userId: "user-123" },
      scans: [scanLatest, scanPrev],
    });

    const res = await GET(makeRequest("/api/scans/compare?pullRequestId=pr-1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.isComparable).toBe(true);
    expect(json.summary.newCount).toBe(1);
    expect(json.summary.fixedCount).toBe(1);
    expect(json.summary.unchangedCount).toBe(1);

    expect(json.groups.new.findings[0].id).toBe("f-4");
    expect(json.groups.fixed.findings[0].id).toBe("f-1");
    expect(json.groups.unchanged.findings[0].id).toBe("f-3");

    expect(json.summary.newSeverityCounts.MEDIUM).toBe(1);
    expect(json.summary.fixedSeverityCounts.CRITICAL).toBe(1);
    expect(json.summary.unchangedSeverityCounts.HIGH).toBe(1);
  });

  it("compares two explicitly chosen scans across PR", async () => {
    const f1 = {
      id: "f-1",
      fingerprint: "fp-1",
      type: "Secret",
      severity: "HIGH",
      fileLocation: "src/a.ts",
    };

    const baseScan = {
      id: "scan-a",
      pullRequestId: "pr-1",
      headSha: "shaA",
      createdAt: new Date("2026-11-20T10:00:00Z"),
      riskScore: 10,
      findings: [f1],
      pullRequest: {
        id: "pr-1",
        prNumber: 7,
        title: "PR",
        repository: { fullName: "acme/api", userId: "user-123" },
      },
    };

    const targetScan = {
      id: "scan-b",
      pullRequestId: "pr-1",
      headSha: "shaB",
      createdAt: new Date("2026-11-21T10:00:00Z"),
      riskScore: 0,
      findings: [],
      pullRequest: {
        id: "pr-1",
        prNumber: 7,
        title: "PR",
        repository: { fullName: "acme/api", userId: "user-123" },
      },
    };

    scanResultFindUniqueMock.mockResolvedValueOnce(baseScan).mockResolvedValueOnce(targetScan);

    const res = await GET(makeRequest("/api/scans/compare?baseScanId=scan-a&targetScanId=scan-b"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.isComparable).toBe(true);
    expect(json.summary.fixedCount).toBe(1);
    expect(json.summary.newCount).toBe(0);
    expect(json.summary.unchangedCount).toBe(0);
  });

  it("returns 400 when two scans belong to different pull requests", async () => {
    scanResultFindUniqueMock
      .mockResolvedValueOnce({
        id: "scan-a",
        pullRequestId: "pr-1",
        pullRequest: { repository: { userId: "user-123" } },
        findings: [],
      })
      .mockResolvedValueOnce({
        id: "scan-b",
        pullRequestId: "pr-2",
        pullRequest: { repository: { userId: "user-123" } },
        findings: [],
      });

    const res = await GET(makeRequest("/api/scans/compare?baseScanId=scan-a&targetScanId=scan-b"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("same pull request");
  });
});
