import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  ClearanceLevel,
  parseClearanceLevel,
  getUserClearance,
  hasClearance,
  verifyOperatorClearance,
  requireOperatorClearance,
  ClearanceError,
  withOperatorClearance,
} from "./clearance";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";

describe("Operator Clearance Authorization Middleware", () => {
  describe("parseClearanceLevel", () => {
    it("parses numeric values correctly", () => {
      expect(parseClearanceLevel(ClearanceLevel.USER)).toBe(ClearanceLevel.USER);
      expect(parseClearanceLevel(ClearanceLevel.OPERATOR)).toBe(ClearanceLevel.OPERATOR);
      expect(parseClearanceLevel(ClearanceLevel.SECURITY_LEAD)).toBe(ClearanceLevel.SECURITY_LEAD);
      expect(parseClearanceLevel(ClearanceLevel.ADMIN)).toBe(ClearanceLevel.ADMIN);
    });

    it("parses string role names case-insensitively", () => {
      expect(parseClearanceLevel("admin")).toBe(ClearanceLevel.ADMIN);
      expect(parseClearanceLevel("ADMIN")).toBe(ClearanceLevel.ADMIN);
      expect(parseClearanceLevel("security_lead")).toBe(ClearanceLevel.SECURITY_LEAD);
      expect(parseClearanceLevel("lead")).toBe(ClearanceLevel.SECURITY_LEAD);
      expect(parseClearanceLevel("operator")).toBe(ClearanceLevel.OPERATOR);
      expect(parseClearanceLevel("user")).toBe(ClearanceLevel.USER);
      expect(parseClearanceLevel("unknown_role")).toBe(ClearanceLevel.USER);
    });
  });

  describe("getUserClearance", () => {
    it("returns null for unauthenticated sessions", () => {
      expect(getUserClearance(null)).toBeNull();
      expect(getUserClearance(undefined)).toBeNull();
      expect(getUserClearance({})).toBeNull();
      expect(getUserClearance({ user: {} as any })).toBeNull();
    });

    it("evaluates clearance based on roles array", () => {
      expect(getUserClearance({ user: { id: "u1", roles: ["USER"] } })).toBe(ClearanceLevel.USER);
      expect(getUserClearance({ user: { id: "u2", roles: ["USER", "OPERATOR"] } })).toBe(
        ClearanceLevel.OPERATOR,
      );
      expect(
        getUserClearance({ user: { id: "u3", roles: ["USER", "OPERATOR", "SECURITY_LEAD"] } }),
      ).toBe(ClearanceLevel.SECURITY_LEAD);
      expect(
        getUserClearance({ user: { id: "u4", roles: ["USER", "ADMIN"] } }),
      ).toBe(ClearanceLevel.ADMIN);
    });

    it("respects explicit clearance attribute", () => {
      expect(
        getUserClearance({ user: { id: "u5", clearance: "SECURITY_LEAD", roles: ["USER"] } }),
      ).toBe(ClearanceLevel.SECURITY_LEAD);
    });
  });

  describe("hasClearance", () => {
    it("returns false for unauthenticated users", () => {
      expect(hasClearance(null, ClearanceLevel.OPERATOR)).toBe(false);
    });

    it("returns true only when clearance is at or above required", () => {
      const userSession = { user: { id: "u1", roles: ["USER"] } };
      const operatorSession = { user: { id: "u2", roles: ["OPERATOR"] } };
      const adminSession = { user: { id: "u3", roles: ["ADMIN"] } };

      expect(hasClearance(userSession, ClearanceLevel.USER)).toBe(true);
      expect(hasClearance(userSession, ClearanceLevel.OPERATOR)).toBe(false);
      expect(hasClearance(userSession, ClearanceLevel.ADMIN)).toBe(false);

      expect(hasClearance(operatorSession, ClearanceLevel.USER)).toBe(true);
      expect(hasClearance(operatorSession, ClearanceLevel.OPERATOR)).toBe(true);
      expect(hasClearance(operatorSession, ClearanceLevel.ADMIN)).toBe(false);

      expect(hasClearance(adminSession, ClearanceLevel.USER)).toBe(true);
      expect(hasClearance(adminSession, ClearanceLevel.OPERATOR)).toBe(true);
      expect(hasClearance(adminSession, ClearanceLevel.ADMIN)).toBe(true);
    });
  });

  describe("verifyOperatorClearance & requireOperatorClearance", () => {
    it("verifies unauthenticated sessions properly", () => {
      const result = verifyOperatorClearance(null, ClearanceLevel.OPERATOR);
      expect(result.authorized).toBe(false);
      expect(result.clearance).toBeNull();
      expect(result.requiredClearance).toBe(ClearanceLevel.OPERATOR);

      expect(() => requireOperatorClearance(null, ClearanceLevel.OPERATOR)).toThrow(ClearanceError);
      try {
        requireOperatorClearance(null, ClearanceLevel.OPERATOR);
      } catch (e: any) {
        expect(e.statusCode).toBe(401);
      }
    });

    it("verifies insufficient clearance sessions properly", () => {
      const session = { user: { id: "u1", roles: ["USER"] } };
      const result = verifyOperatorClearance(session, ClearanceLevel.OPERATOR);
      expect(result.authorized).toBe(false);
      expect(result.clearance).toBe(ClearanceLevel.USER);

      expect(() => requireOperatorClearance(session, ClearanceLevel.OPERATOR)).toThrow(ClearanceError);
      try {
        requireOperatorClearance(session, ClearanceLevel.OPERATOR);
      } catch (e: any) {
        expect(e.statusCode).toBe(403);
        expect(e.currentClearance).toBe(ClearanceLevel.USER);
        expect(e.requiredClearance).toBe(ClearanceLevel.OPERATOR);
      }
    });

    it("passes for authorized operator clearance", () => {
      const session = { user: { id: "u2", roles: ["OPERATOR"] } };
      const result = verifyOperatorClearance(session, ClearanceLevel.OPERATOR);
      expect(result.authorized).toBe(true);
      expect(result.clearance).toBe(ClearanceLevel.OPERATOR);

      expect(() => requireOperatorClearance(session, ClearanceLevel.OPERATOR)).not.toThrow();
    });
  });

  describe("withOperatorClearance middleware", () => {
    it("returns 401 when no session is present", async () => {
      vi.mocked(auth).mockResolvedValueOnce(null as any);

      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = withOperatorClearance(handler, { requiredClearance: ClearanceLevel.OPERATOR });

      const req = new NextRequest("http://localhost/api/action", { method: "POST" });
      const res = await wrapped(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
      expect(handler).not.toHaveBeenCalled();
    });

    it("returns 403 when user does not have sufficient clearance", async () => {
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: "user-1", roles: ["USER"] },
      } as any);

      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = withOperatorClearance(handler, { requiredClearance: ClearanceLevel.OPERATOR });

      const req = new NextRequest("http://localhost/api/action", { method: "POST" });
      const res = await wrapped(req);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("Forbidden");
      expect(data.requiredClearance).toBe("OPERATOR");
      expect(data.currentClearance).toBe("USER");
      expect(handler).not.toHaveBeenCalled();
    });

    it("executes handler with clearance context when operator clearance is verified", async () => {
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: "op-1", roles: ["OPERATOR"] },
      } as any);

      const handler = vi.fn().mockImplementation(async (req, ctx) => {
        return NextResponse.json({ ok: true, clearance: ctx.clearance });
      });
      const wrapped = withOperatorClearance(handler, { requiredClearance: ClearanceLevel.OPERATOR });

      const req = new NextRequest("http://localhost/api/action", { method: "POST" });
      const res = await wrapped(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.clearance).toBe(ClearanceLevel.OPERATOR);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("allows higher clearance like ADMIN to execute OPERATOR actions", async () => {
      vi.mocked(auth).mockResolvedValueOnce({
        user: { id: "admin-1", roles: ["ADMIN"] },
      } as any);

      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
      const wrapped = withOperatorClearance(handler, { requiredClearance: ClearanceLevel.OPERATOR });

      const req = new NextRequest("http://localhost/api/action", { method: "POST" });
      const res = await wrapped(req);

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
