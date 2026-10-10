import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

import { GET, POST } from "./route";
import { resetModelCircuitBreakers, getModelCircuitBreaker } from "@/ai/resilience";
import { clearTelemetry, DEFAULT_PRIMARY_GROQ_MODEL } from "@/ai/telemetry";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init as any);
}

describe("Admin AI Health API Route (/api/admin/ai-health)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetModelCircuitBreakers();
    await clearTelemetry();
  });

  describe("Authentication and Authorization", () => {
    it("should reject unauthenticated requests with 401", async () => {
      mockAuth.mockResolvedValue(null);

      const req = makeRequest("http://localhost:3000/api/admin/ai-health");
      const res = await GET(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.message || data.error).toMatch(/unauthorized/i);
    });


    it("should reject non-admin users with 401", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "user-1", email: "dev@secureflow.io", roles: ["USER"] },
      });

      const req = makeRequest("http://localhost:3000/api/admin/ai-health");
      const res = await GET(req);

      expect(res.status).toBe(401);
    });

    it("should allow ADMIN users to access telemetry", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@secureflow.io", roles: ["ADMIN"] },
      });

      const req = makeRequest("http://localhost:3000/api/admin/ai-health");
      const res = await GET(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("models");
      expect(data).toHaveProperty("primaryModel");
      expect(data).toHaveProperty("primaryTripped");
      expect(Array.isArray(data.models)).toBe(true);
    });
  });

  describe("Admin Circuit Breaker Actions (POST)", () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", email: "admin@secureflow.io", roles: ["ADMIN"] },
      });
    });

    it("should manually trip a circuit breaker for a specified model", async () => {
      const breaker = getModelCircuitBreaker(DEFAULT_PRIMARY_GROQ_MODEL);
      expect(breaker.getState()).toBe(0); // CLOSED

      const req = makeRequest("http://localhost:3000/api/admin/ai-health", {
        method: "POST",
        body: JSON.stringify({
          action: "trip",
          modelName: DEFAULT_PRIMARY_GROQ_MODEL,
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stats.stateName).toBe("OPEN");
      expect(breaker.getState()).toBe(1); // OPEN
    });

    it("should manually reset a circuit breaker for a specified model", async () => {
      const breaker = getModelCircuitBreaker(DEFAULT_PRIMARY_GROQ_MODEL);
      breaker.trip();
      expect(breaker.getState()).toBe(1); // OPEN

      const req = makeRequest("http://localhost:3000/api/admin/ai-health", {
        method: "POST",
        body: JSON.stringify({
          action: "reset",
          modelName: DEFAULT_PRIMARY_GROQ_MODEL,
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stats.stateName).toBe("CLOSED");
      expect(breaker.getState()).toBe(0); // CLOSED
    });

    it("should reject invalid actions with 400", async () => {
      const req = makeRequest("http://localhost:3000/api/admin/ai-health", {
        method: "POST",
        body: JSON.stringify({
          action: "invalid_action",
          modelName: "test-model",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("should reject trip/reset actions without modelName with 400", async () => {
      const req = makeRequest("http://localhost:3000/api/admin/ai-health", {
        method: "POST",
        body: JSON.stringify({
          action: "trip",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("should support clear telemetry action", async () => {
      const req = makeRequest("http://localhost:3000/api/admin/ai-health", {
        method: "POST",
        body: JSON.stringify({
          action: "clear",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message).toMatch(/cleared/i);
    });
  });
});
