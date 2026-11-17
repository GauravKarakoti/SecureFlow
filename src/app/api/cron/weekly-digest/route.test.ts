import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const { generateAllWeeklyDigestsMock } = vi.hoisted(() => ({
  generateAllWeeklyDigestsMock: vi.fn(),
}));

vi.mock("@/lib/digest/digest-service", () => ({
  generateAllWeeklyDigests: generateAllWeeklyDigestsMock,
}));

describe("GET & POST /api/cron/weekly-digest (#1788)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects unauthorized requests with 401 when CRON_SECRET is configured", async () => {
    process.env.CRON_SECRET = "super-secret-cron-token";

    const req = new NextRequest("http://localhost:3000/api/cron/weekly-digest", {
      method: "GET",
      headers: {
        authorization: "Bearer wrong-token",
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("UNAUTHORIZED");
    expect(generateAllWeeklyDigestsMock).not.toHaveBeenCalled();
  });

  it("accepts valid Bearer token authorization", async () => {
    process.env.CRON_SECRET = "super-secret-cron-token";
    generateAllWeeklyDigestsMock.mockResolvedValueOnce({
      totalUsers: 5,
      generated: 3,
      skipped: 2,
      errors: [],
    });

    const req = new NextRequest("http://localhost:3000/api/cron/weekly-digest", {
      method: "POST",
      headers: {
        authorization: "Bearer super-secret-cron-token",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.totalUsers).toBe(5);
    expect(data.generated).toBe(3);
    expect(data.skipped).toBe(2);
    expect(generateAllWeeklyDigestsMock).toHaveBeenCalledWith({ force: false });
  });

  it("accepts valid x-cron-secret header", async () => {
    process.env.CRON_SECRET = "super-secret-cron-token";
    generateAllWeeklyDigestsMock.mockResolvedValueOnce({
      totalUsers: 2,
      generated: 2,
      skipped: 0,
      errors: [],
    });

    const req = new NextRequest("http://localhost:3000/api/cron/weekly-digest", {
      method: "GET",
      headers: {
        "x-cron-secret": "super-secret-cron-token",
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.generated).toBe(2);
  });

  it("passes force: true when requested in query parameter", async () => {
    process.env.CRON_SECRET = "token";
    generateAllWeeklyDigestsMock.mockResolvedValueOnce({
      totalUsers: 1,
      generated: 1,
      skipped: 0,
      errors: [],
    });

    const req = new NextRequest("http://localhost:3000/api/cron/weekly-digest?force=true", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(generateAllWeeklyDigestsMock).toHaveBeenCalledWith({ force: true });
  });

  it("rejects in production when CRON_SECRET is not configured", async () => {
    (process.env as any).NODE_ENV = "production";
    delete process.env.CRON_SECRET;

    const req = new NextRequest("http://localhost:3000/api/cron/weekly-digest", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(generateAllWeeklyDigestsMock).not.toHaveBeenCalled();
  });

  it("returns 500 when digest generation encounters an unhandled exception", async () => {
    delete process.env.CRON_SECRET;
    (process.env as any).NODE_ENV = "development";
    generateAllWeeklyDigestsMock.mockRejectedValueOnce(new Error("Database connection lost"));

    const req = new NextRequest("http://localhost:3000/api/cron/weekly-digest", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("INTERNAL_SERVER_ERROR");
    expect(data.message).toBe("Database connection lost");
  });
});
