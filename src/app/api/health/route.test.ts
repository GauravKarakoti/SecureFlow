import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@/lib/health-check";

const mockAuth = vi.hoisted(() => vi.fn());
const mockRunHealthCheck = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/health-check", () => ({ runHealthCheck: mockRunHealthCheck }));

import { GET } from "./route";

function report(status: HealthReport["status"]): HealthReport {
  return {
    status,
    timestamp: "2026-09-19T00:00:00.000Z",
    uptime: 12,
    components: [
      {
        name: "PostgreSQL",
        status: "down",
        latencyMs: 4,
        message: "Can't reach database server at `db.internal-prod.example:5432`",
      },
      { name: "Redis", status: "healthy", latencyMs: 2 },
    ],
  };
}

beforeEach(() => {
  mockAuth.mockReset().mockResolvedValue(null);
  mockRunHealthCheck.mockReset().mockResolvedValue(report("healthy"));
});

describe("GET /api/health", () => {
  it("hides component error messages from anonymous callers", async () => {
    mockRunHealthCheck.mockResolvedValue(report("down"));

    const res = await GET();
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain("db.internal-prod.example");
    expect(body.components).toEqual([
      { name: "PostgreSQL", status: "down", latencyMs: 4 },
      { name: "Redis", status: "healthy", latencyMs: 2 },
    ]);
    expect(body).toMatchObject({ status: "down", uptime: 12 });
  });

  it("keeps the messages for a signed-in user, for the status page", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });

    const body = await (await GET()).json();

    expect(body).toEqual(report("healthy"));
  });

  it("treats a session lookup failure as anonymous rather than failing the check", async () => {
    mockAuth.mockRejectedValue(new Error("JWT decode failed"));

    const res = await GET();

    expect(res.status).toBe(200);
    expect((await res.json()).components[0]).not.toHaveProperty("message");
  });

  it("mirrors the aggregate in the HTTP status and is never cached", async () => {
    mockRunHealthCheck.mockResolvedValueOnce(report("down"));
    const down = await GET();
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");

    mockRunHealthCheck.mockResolvedValueOnce(report("degraded"));
    expect((await GET()).status).toBe(200);
  });
});
