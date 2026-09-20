import { describe, expect, it } from "vitest";
import { AuditSanitizer } from "./auditSanitizer";

const roundTrip = (payload: unknown) =>
  AuditSanitizer.deserializePayload(AuditSanitizer.serializePayload(payload));

describe("AuditSanitizer", () => {
  it("round-trips a Date as a Date, not as its ISO string", () => {
    const at = new Date("2026-09-19T04:30:00.000Z");

    const restored = roundTrip({ at });

    expect(restored.at).toBeInstanceOf(Date);
    expect(restored.at.toISOString()).toBe(at.toISOString());
  });

  it("tags a Date in the serialized form", () => {
    expect(AuditSanitizer.serializePayload({ at: new Date("2026-01-01T00:00:00Z") })).toBe(
      '{"at":{"_type":"Date","value":"2026-01-01T00:00:00.000Z"}}',
    );
  });

  it("round-trips a top-level Date", () => {
    expect(roundTrip(new Date(0))).toEqual(new Date(0));
  });

  it("keeps an Invalid Date invalid instead of throwing", () => {
    const restored = roundTrip({ at: new Date("not a date") });

    expect(restored.at).toBeInstanceOf(Date);
    expect(Number.isNaN(restored.at.getTime())).toBe(true);
  });

  it("round-trips Maps and Sets, including Dates nested inside them", () => {
    const seen = new Date("2026-02-03T00:00:00Z");
    const payload = {
      byRepo: new Map([["org/api", { seen }]]),
      tags: new Set(["secret", "ci"]),
      history: [seen],
    };

    const restored = roundTrip(payload);

    expect(restored.byRepo).toBeInstanceOf(Map);
    expect(restored.byRepo.get("org/api").seen).toEqual(seen);
    expect(restored.tags).toEqual(new Set(["secret", "ci"]));
    expect(restored.history[0]).toEqual(seen);
  });

  it("leaves plain JSON values untouched", () => {
    const payload = { action: "SCAN", count: 2, ok: true, none: null, list: [1, "a"] };

    expect(roundTrip(payload)).toEqual(payload);
  });
});
