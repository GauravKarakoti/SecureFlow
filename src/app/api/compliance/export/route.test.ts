import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

import { GET } from "./route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init as any);
}

describe("Compliance Export API Route (/api/compliance/export)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject unauthenticated requests with 401", async () => {
    mockAuth.mockResolvedValue(null);

    const req = makeRequest("http://localhost:3000/api/compliance/export");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("should return JSON compliance dossier by default for authenticated users", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "auditor@secureflow.io" },
    });

    const req = makeRequest("http://localhost:3000/api/compliance/export");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("reportId");
    expect(data).toHaveProperty("metrics");
    expect(data).toHaveProperty("frameworks");
    expect(data).toHaveProperty("cryptographicProof");
  });

  it("should return SARIF document when format=sarif is requested", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "auditor@secureflow.io" },
    });

    const req = makeRequest("http://localhost:3000/api/compliance/export?format=sarif");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/sarif+json");
    expect(res.headers.get("content-disposition")).toContain(".sarif");

    const sarif = await res.json();
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toBeDefined();
  });

  it("should return HTML/PDF summary when format=pdf is requested", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "auditor@secureflow.io" },
    });

    const req = makeRequest("http://localhost:3000/api/compliance/export?format=pdf");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("SecureFlow Compliance Audit Report");
  });

  it("should reject invalid date parameters with 400", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "auditor@secureflow.io" },
    });

    const req = makeRequest("http://localhost:3000/api/compliance/export?from=invalid-date");
    const res = await GET(req);

    expect(res.status).toBe(400);
  });
});
