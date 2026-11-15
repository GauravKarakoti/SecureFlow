import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  ArmorIQTimeoutError,
  ArmorIQUnreachableError,
} from "../../../../../__mocks__/@armoriq/sdk";

const { authMock, fetchTracesMock, recordAuditLogMock, buildReportMock, verifyOwnershipMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    fetchTracesMock: vi.fn(),
    recordAuditLogMock: vi.fn(),
    buildReportMock: vi.fn(),
    verifyOwnershipMock: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/armor/audit-integration", () => ({
  fetchArmorIQAuditTraces: fetchTracesMock,
  recordArmorIQAuditLog: recordAuditLogMock,
  buildComplianceReport: buildReportMock,
  verifyArmorIQAuditResourceOwnership: verifyOwnershipMock,
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: {
    STANDARD: { limit: 120, windowSeconds: 60, fallbackStrategy: "fail-closed" },
  },
  withRateLimit: <T>(handler: T): T => handler,
}));

import { GET, POST } from "./route";

describe("GET /api/audit/armoriq", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 Unauthorized when session is missing", async () => {
    authMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
    expect(fetchTracesMock).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when user is suspended", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-suspended", role: "SUSPENDED" } });

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq");
    const res = await GET(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden" });
    expect(fetchTracesMock).not.toHaveBeenCalled();
  });

  it("retrieves ArmorIQ audit traces with default parameters", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    const mockTraces = [
      {
        id: "trace-1",
        scanJobId: "job-1",
        decision: "ALLOW",
        toolName: "ast-scanner",
        timestamp: new Date().toISOString(),
      },
    ];
    fetchTracesMock.mockResolvedValueOnce({ traces: mockTraces, total: 1 });

    const req = new NextRequest(
      "http://localhost:3000/api/audit/armoriq?scanJobId=job-1&decision=ALLOW",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ traces: mockTraces, total: 1 });
    expect(fetchTracesMock).toHaveBeenCalledWith({
      userId: "user-123",
      scanJobId: "job-1",
      findingId: undefined,
      decision: "ALLOW",
      limit: 100,
      offset: 0,
    });
  });

  it("passes the dashboard limit and offset through to the trace query", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    fetchTracesMock.mockResolvedValueOnce({ traces: [], total: 42 });

    const req = new NextRequest(
      "http://localhost:3000/api/audit/armoriq?limit=10&offset=20&decision=BLOCK",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fetchTracesMock).toHaveBeenCalledWith({
      userId: "user-123",
      scanJobId: undefined,
      findingId: undefined,
      decision: "BLOCK",
      limit: 10,
      offset: 20,
    });
  });

  it("clamps pagination values instead of passing malformed numbers to Prisma", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    fetchTracesMock.mockResolvedValueOnce({ traces: [], total: 0 });

    const req = new NextRequest(
      "http://localhost:3000/api/audit/armoriq?limit=1000&offset=999999999",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fetchTracesMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 1_000_000 }),
    );
  });

  it("falls back to the defaults when pagination parameters are not integers", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    fetchTracesMock.mockResolvedValueOnce({ traces: [], total: 0 });

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq?limit=ten&offset=1.5");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fetchTracesMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 0 }),
    );
  });

  it("passes cursor parameter and returns nextCursor", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    fetchTracesMock.mockResolvedValueOnce({
      traces: [{ id: "trace-1" }],
      total: 10,
      nextCursor: "cursor-abc",
    });

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq?cursor=some-cursor");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe("cursor-abc");
    expect(fetchTracesMock).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "some-cursor" }),
    );
  });

  it("generates a compliance report when format=compliance is requested", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    const mockTraces = [{ id: "trace-1", decision: "ALLOW" }];
    const mockEvidence = [{ control: "CC6.1", status: "PASS" }];

    fetchTracesMock.mockResolvedValueOnce({ traces: mockTraces, total: 1 });
    buildReportMock.mockReturnValueOnce(mockEvidence);

    const req = new NextRequest(
      "http://localhost:3000/api/audit/armoriq?format=compliance&framework=SOC2",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.framework).toBe("SOC2");
    expect(body.totalRecords).toBe(1);
    expect(body.evidence).toEqual(mockEvidence);
    expect(buildReportMock).toHaveBeenCalledWith(mockTraces, "SOC2");
  });

  it("returns 503 when upstream ArmorIQ audit service times out on GET", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    fetchTracesMock.mockRejectedValueOnce(new ArmorIQTimeoutError());

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq");
    const res = await GET(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("temporarily unavailable");
  });

  it("returns 500 when fetchArmorIQAuditTraces throws a generic error", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    fetchTracesMock.mockRejectedValueOnce(new Error("Database disconnected"));

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq");
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to retrieve ArmorIQ audit traces");
  });
});

describe("POST /api/audit/armoriq", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyOwnershipMock.mockResolvedValue(true);
  });

  it("returns 401 Unauthorized when session is missing", async () => {
    authMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", toolName: "bash", decision: "ALLOW" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when user account is suspended or lacks permission", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-suspended", role: "SUSPENDED" } });

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", toolName: "bash", decision: "ALLOW" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden" });
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when required audit fields are missing", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1" }), // missing toolName and decision
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("agentId, toolName, and decision");
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request when decision is not ALLOW, BLOCK, or HOLD", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", toolName: "bash", decision: "INVALID_CHOICE" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("('ALLOW' | 'BLOCK' | 'HOLD')");
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns 404 and writes nothing when the scan job or finding belongs to another user", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    verifyOwnershipMock.mockResolvedValueOnce(false);

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({
        scanJobId: "job-owned-by-someone-else",
        findingId: "finding-owned-by-someone-else",
        agentId: "agent-1",
        toolName: "bash",
        decision: "ALLOW",
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Scan job or finding not found" });
    expect(verifyOwnershipMock).toHaveBeenCalledWith({
      userId: "user-123",
      scanJobId: "job-owned-by-someone-else",
      findingId: "finding-owned-by-someone-else",
    });
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("records an ArmorIQ audit log entry successfully returning 201 Created and dashboard-aligned schema", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    const mockLog = {
      id: "log-1",
      agentId: "agent-remediation-patch-generator",
      toolName: "src/auth/login.ts",
      decision: "ALLOW",
      ruleMatched: "allow:whitelisted_tool",
      justification: "Action complies with policy",
      proofHash: "a1b2c3d4e5",
      signature: "f6e5d4c3b2",
      intentId: "intent_12345",
      frameworks: ["SOC 2 (CC6.1)", "GDPR (Art. 32)", "NIST SP 800-53 (AC-3)"],
      timestamp: new Date().toISOString(),
    };
    recordAuditLogMock.mockResolvedValueOnce(mockLog);

    const payload = {
      scanJobId: "job-100",
      findingId: "finding-200",
      agentId: "agent-remediation-patch-generator",
      toolName: "src/auth/login.ts",
      decision: "ALLOW" as const,
      ruleMatched: "allow:whitelisted_tool",
      justification: "Action complies with policy",
      proofHash: "a1b2c3d4e5",
      signature: "f6e5d4c3b2",
      intentId: "intent_12345",
      frameworks: ["SOC 2 (CC6.1)", "GDPR (Art. 32)", "NIST SP 800-53 (AC-3)"],
    };

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ success: true, log: mockLog });
    expect(recordAuditLogMock).toHaveBeenCalledWith({
      ...payload,
      userId: "user-123",
    });

    // Verification against Dashboard Audit Table expected metadata schema (audit-log-table.test.tsx)
    expect(body.log.agentId).toBe("agent-remediation-patch-generator");
    expect(body.log.decision).toBe("ALLOW");
    expect(body.log.proofHash).toBe("a1b2c3d4e5");
    expect(body.log.signature).toBe("f6e5d4c3b2");
    expect(body.log.frameworks).toContain("SOC 2 (CC6.1)");
  });

  it("returns 502 Bad Gateway when upstream ArmorIQ service gateway fails", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    const gatewayError = new Error("Bad gateway from ArmorIQ cluster");
    (gatewayError as any).status = 502;
    recordAuditLogMock.mockRejectedValueOnce(gatewayError);

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({
        agentId: "agent-1",
        toolName: "bash",
        decision: "ALLOW",
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("invalid gateway response");
  });

  it("returns 503 Service Unavailable when upstream ArmorIQ service is unreachable or times out", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    recordAuditLogMock.mockRejectedValueOnce(new ArmorIQUnreachableError());

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({
        agentId: "agent-1",
        toolName: "bash",
        decision: "ALLOW",
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("temporarily unreachable");
  });

  it("returns 500 when recordArmorIQAuditLog returns null", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    recordAuditLogMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({
        agentId: "agent-1",
        toolName: "bash",
        decision: "ALLOW",
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to record ArmorIQ enforcement audit log");
  });

  it("returns 500 when recordArmorIQAuditLog throws a generic unexpected error", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    recordAuditLogMock.mockRejectedValueOnce(new Error("Database connection dropped"));

    const req = new NextRequest("http://localhost:3000/api/audit/armoriq", {
      method: "POST",
      body: JSON.stringify({
        agentId: "agent-1",
        toolName: "bash",
        decision: "ALLOW",
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to record ArmorIQ enforcement audit log");
  });
});
