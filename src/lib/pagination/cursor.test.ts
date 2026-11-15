import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  parseLimit,
  buildCursorWhere,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./cursor";

describe("cursor pagination utilities", () => {
  it("encodes and decodes a cursor round-trip", () => {
    const originalDate = new Date("2026-11-15T10:00:00.000Z");
    const id = "finding-123";

    const encoded = encodeCursor({ createdAt: originalDate, id });
    expect(typeof encoded).toBe("string");
    expect(encoded).not.toContain(" ");

    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.createdAt.toISOString()).toBe(originalDate.toISOString());
    expect(decoded?.id).toBe(id);
  });

  it("handles timestamp property as fallback for createdAt", () => {
    const timestamp = new Date("2026-11-14T08:30:00.000Z");
    const id = "audit-456";

    const encoded = encodeCursor({ timestamp, id });
    const decoded = decodeCursor(encoded);
    expect(decoded?.createdAt.toISOString()).toBe(timestamp.toISOString());
    expect(decoded?.id).toBe(id);
  });

  it("returns null for malformed or invalid cursors", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base-64!")).toBeNull();
    expect(decodeCursor(Buffer.from("not json").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ id: "1" })).toString("base64url"))).toBeNull();
    expect(
      decodeCursor(
        Buffer.from(JSON.stringify({ createdAt: "invalid-date", id: "1" })).toString("base64url"),
      ),
    ).toBeNull();
  });

  describe("parseLimit", () => {
    it("returns default limit when parameter is omitted or empty", () => {
      expect(parseLimit(null)).toBe(DEFAULT_PAGE_LIMIT);
      expect(parseLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
      expect(parseLimit("")).toBe(DEFAULT_PAGE_LIMIT);
    });

    it("clamps limit above maximum", () => {
      expect(parseLimit(500)).toBe(MAX_PAGE_LIMIT);
      expect(parseLimit("1000")).toBe(MAX_PAGE_LIMIT);
      expect(parseLimit(500, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)).toBe(MAX_PAGE_LIMIT);
    });

    it("returns default limit for negative or non-numeric input", () => {
      expect(parseLimit("-5")).toBe(DEFAULT_PAGE_LIMIT);
      expect(parseLimit("abc")).toBe(DEFAULT_PAGE_LIMIT);
      expect(parseLimit(0)).toBe(DEFAULT_PAGE_LIMIT);
    });

    it("accepts valid limits within range", () => {
      expect(parseLimit("25")).toBe(25);
      expect(parseLimit(50)).toBe(50);
      expect(parseLimit(1)).toBe(1);
    });
  });

  describe("buildCursorWhere", () => {
    it("returns empty object when cursor is null", () => {
      expect(buildCursorWhere(null)).toEqual({});
    });

    it("builds compound keyset condition for createdAt", () => {
      const date = new Date("2026-11-15T12:00:00.000Z");
      const cursor = { createdAt: date, id: "item-99" };
      const where = buildCursorWhere(cursor, "createdAt");

      expect(where).toEqual({
        OR: [
          { createdAt: { lt: date } },
          {
            AND: [{ createdAt: date }, { id: { lt: "item-99" } }],
          },
        ],
      });
    });

    it("builds compound keyset condition for timestamp", () => {
      const date = new Date("2026-11-15T12:00:00.000Z");
      const cursor = { createdAt: date, id: "item-99" };
      const where = buildCursorWhere(cursor, "timestamp");

      expect(where).toEqual({
        OR: [
          { timestamp: { lt: date } },
          {
            AND: [{ timestamp: date }, { id: { lt: "item-99" } }],
          },
        ],
      });
    });
  });
});
