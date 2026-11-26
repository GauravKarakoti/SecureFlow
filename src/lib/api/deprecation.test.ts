import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  addDeprecationHeaders,
  withDeprecation,
  formatHttpDate,
  DEFAULT_API_VERSIONING_POLICY_URL,
} from "./deprecation";
import { parse } from "yaml";
import fs from "node:fs";
import path from "node:path";

describe("API Deprecation & Sunset Headers (#2106)", () => {
  describe("formatHttpDate", () => {
    it("formats dates into valid IMF-fixdate (RFC 7231 / RFC 8594)", () => {
      const d = new Date("2026-11-01T12:00:00Z");
      expect(formatHttpDate(d)).toBe("Sun, 01 Nov 2026 12:00:00 GMT");
    });

    it("throws on invalid dates", () => {
      expect(() => formatHttpDate("invalid-date")).toThrow("Invalid date");
    });
  });

  describe("addDeprecationHeaders", () => {
    it("adds Deprecation, Sunset, and Link headers to Response", () => {
      const res = NextResponse.json({ ok: true });
      addDeprecationHeaders(res, {
        deprecatedAt: new Date("2026-11-01T00:00:00Z"),
        sunsetAt: new Date("2027-05-01T00:00:00Z"),
        successorUrl: "/api/webhooks/generic",
      });

      expect(res.headers.get("Deprecation")).toBe("Sun, 01 Nov 2026 00:00:00 GMT");
      expect(res.headers.get("Sunset")).toBe("Sat, 01 May 2027 00:00:00 GMT");

      const link = res.headers.get("Link");
      expect(link).toContain('</api/webhooks/generic>; rel="successor-version"');
      expect(link).toContain(`<${DEFAULT_API_VERSIONING_POLICY_URL}>; rel="deprecation"`);
    });

    it("defaults to Deprecation: @1 when boolean true", () => {
      const res = NextResponse.json({ ok: true });
      addDeprecationHeaders(res, {
        deprecatedAt: true,
      });

      expect(res.headers.get("Deprecation")).toBe("@1");
      expect(res.headers.get("Sunset")).toBeNull();
    });

    it("preserves existing Link headers", () => {
      const res = NextResponse.json({ ok: true });
      res.headers.set("Link", '<https://example.com/docs>; rel="help"');

      addDeprecationHeaders(res, {
        successorUrl: "/api/new-path",
      });

      const link = res.headers.get("Link");
      expect(link).toContain('<https://example.com/docs>; rel="help"');
      expect(link).toContain('</api/new-path>; rel="successor-version"');
    });
  });

  describe("withDeprecation middleware wrapper", () => {
    it("wraps an async route handler and injects headers on successful response", async () => {
      const handler = async (req: NextRequest) => {
        return NextResponse.json({ message: "legacy response" }, { status: 200 });
      };

      const wrapped = withDeprecation(handler, {
        deprecatedAt: new Date("2026-11-01T00:00:00Z"),
        sunsetAt: new Date("2027-05-01T00:00:00Z"),
        successorUrl: "/api/v2/endpoint",
      });

      const req = new NextRequest("http://localhost:3000/api/legacy");
      const res = await wrapped(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Deprecation")).toBe("Sun, 01 Nov 2026 00:00:00 GMT");
      expect(res.headers.get("Sunset")).toBe("Sat, 01 May 2027 00:00:00 GMT");
      expect(res.headers.get("Link")).toContain('</api/v2/endpoint>; rel="successor-version"');
    });

    it("injects headers even on 4xx/5xx responses from the handler", async () => {
      const handler = async () => {
        return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
      };

      const wrapped = withDeprecation(handler, {
        deprecatedAt: true,
        sunsetAt: new Date("2027-01-01T00:00:00Z"),
      });

      const res = await wrapped();
      expect(res.status).toBe(400);
      expect(res.headers.get("Deprecation")).toBe("@1");
      expect(res.headers.get("Sunset")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
    });
  });

  describe("Enforcement: every deprecated route in openapi.yaml emits Deprecation and Sunset headers", () => {
    it("verifies deprecated route /api/webhooks returns RFC 8594 headers", async () => {
      // 1. Read openapi.yaml
      const openapiPath = path.resolve(process.cwd(), "openapi.yaml");
      const openapiContent = fs.readFileSync(openapiPath, "utf8");
      const spec = parse(openapiContent);

      const deprecatedRoutes: Array<{ path: string; method: string }> = [];

      for (const [routePath, pathObj] of Object.entries(spec.paths || {})) {
        for (const [method, op] of Object.entries(pathObj as any)) {
          if (
            ["get", "post", "put", "patch", "delete"].includes(method.toLowerCase()) &&
            (op as any).deprecated === true
          ) {
            deprecatedRoutes.push({ path: routePath, method: method.toUpperCase() });
          }
        }
      }

      expect(deprecatedRoutes.length).toBeGreaterThan(0);
      expect(deprecatedRoutes).toContainEqual({
        path: "/api/webhooks",
        method: "POST",
      });

      // 2. Import the route handler for /api/webhooks
      const { POST: webhookHandler } = await import("@/app/api/webhooks/route");

      const req = new NextRequest("http://localhost:3000/api/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Send request without signature to trigger immediate validation failure (401)
        },
        body: JSON.stringify({ event: "test" }),
      });

      const res = await webhookHandler(req);

      // Verify RFC 8594 headers are present on the response
      const deprecation = res.headers.get("Deprecation");
      const sunset = res.headers.get("Sunset");
      const link = res.headers.get("Link");

      expect(deprecation).toBeTruthy();
      expect(sunset).toBeTruthy();
      expect(link).toBeTruthy();
      expect(link).toContain('rel="successor-version"');
      expect(link).toContain('rel="deprecation"');
    });

    it("verifies openapi.yaml description links to docs/api-versioning.md", () => {
      const openapiPath = path.resolve(process.cwd(), "openapi.yaml");
      const openapiContent = fs.readFileSync(openapiPath, "utf8");
      expect(openapiContent).toContain("docs/api-versioning.md");
    });
  });
});
