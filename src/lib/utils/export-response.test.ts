import { describe, it, expect } from "vitest";
import {
  buildExportHeaders,
  exportResponse,
  parseDateParam,
  parseLimitParam,
} from "./export-response";

describe("parseDateParam", () => {
  it("returns undefined for absent or blank values", () => {
    expect(parseDateParam(null, "from")).toBeUndefined();
    expect(parseDateParam("", "from")).toBeUndefined();
    expect(parseDateParam("   ", "from")).toBeUndefined();
  });

  it("parses an ISO-8601 date", () => {
    expect(parseDateParam("2026-01-01", "from")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws a 400 naming the parameter for a malformed date", () => {
    expect(() => parseDateParam("last-tuesday", "to")).toThrow(/Invalid `to`/);
  });
});

describe("parseLimitParam", () => {
  it("returns undefined for absent or blank values", () => {
    expect(parseLimitParam(null, 100)).toBeUndefined();
    expect(parseLimitParam("  ", 100)).toBeUndefined();
  });

  it("clamps to the maximum", () => {
    expect(parseLimitParam("999999", 100)).toBe(100);
    expect(parseLimitParam("25", 100)).toBe(25);
  });

  it.each(["0", "-5", "1.5", "abc"])("rejects %s", (raw) => {
    expect(() => parseLimitParam(raw, 100)).toThrow(/Invalid `limit`/);
  });
});

describe("buildExportHeaders", () => {
  it("sets type, attachment filename and no-store", () => {
    expect(
      buildExportHeaders({ contentType: "text/csv; charset=utf-8", filename: "a.csv" }),
    ).toEqual({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="a.csv"',
      "Cache-Control": "no-store",
    });
  });

  it("adds X-Export-Limit only when a limit is given", () => {
    const base = { contentType: "text/csv", filename: "a.csv" };
    expect(buildExportHeaders(base)).not.toHaveProperty("X-Export-Limit");
    expect(buildExportHeaders({ ...base, limit: 50 })["X-Export-Limit"]).toBe("50");
  });

  it("merges route-specific headers", () => {
    const headers = buildExportHeaders({
      contentType: "text/csv",
      filename: "a.csv",
      headers: { "X-Export-Window": "beginning..now" },
    });
    expect(headers["X-Export-Window"]).toBe("beginning..now");
  });
});

describe("exportResponse", () => {
  it("returns a 200 with the shared headers and body", async () => {
    const res = exportResponse("hello", {
      contentType: "text/plain",
      filename: "x.txt",
      limit: 10,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="x.txt"');
    expect(res.headers.get("X-Export-Limit")).toBe("10");
    expect(await res.text()).toBe("hello");
  });
});
