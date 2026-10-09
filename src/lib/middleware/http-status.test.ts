import { describe, it, expect } from "vitest";
import {
  isValidHttpStatus,
  normalizeHttpStatus,
  resolveErrorStatus,
  DEFAULT_ERROR_STATUS,
  MIN_HTTP_STATUS,
  MAX_HTTP_STATUS,
} from "./http-status";

describe("isValidHttpStatus", () => {
  it("accepts the inclusive bounds the Response constructor allows", () => {
    expect(isValidHttpStatus(MIN_HTTP_STATUS)).toBe(true);
    expect(isValidHttpStatus(MAX_HTTP_STATUS)).toBe(true);
    expect(isValidHttpStatus(404)).toBe(true);
  });

  it("rejects values just outside the bounds", () => {
    expect(isValidHttpStatus(199)).toBe(false);
    expect(isValidHttpStatus(600)).toBe(false);
  });

  it("rejects transport codes that are not HTTP statuses", () => {
    expect(isValidHttpStatus(0)).toBe(false);
    expect(isValidHttpStatus(1006)).toBe(false); // WebSocket abnormal closure
  });

  it("rejects non-integers and non-finite numbers", () => {
    expect(isValidHttpStatus(404.5)).toBe(false);
    expect(isValidHttpStatus(Number.NaN)).toBe(false);
    expect(isValidHttpStatus(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rejects non-numbers, including values that would coerce", () => {
    expect(isValidHttpStatus("404")).toBe(false);
    expect(isValidHttpStatus(true)).toBe(false);
    expect(isValidHttpStatus(null)).toBe(false);
    expect(isValidHttpStatus(undefined)).toBe(false);
    expect(isValidHttpStatus({})).toBe(false);
  });
});

describe("normalizeHttpStatus", () => {
  it("passes a valid numeric status straight through", () => {
    expect(normalizeHttpStatus(404)).toBe(404);
    expect(normalizeHttpStatus(201)).toBe(201);
  });

  it("parses numeric strings", () => {
    expect(normalizeHttpStatus("404")).toBe(404);
    expect(normalizeHttpStatus("  429  ")).toBe(429);
  });

  it("falls back for numeric strings outside the valid range", () => {
    expect(normalizeHttpStatus("1006")).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus("0")).toBe(DEFAULT_ERROR_STATUS);
  });

  it("maps Genkit / gRPC status names onto their HTTP equivalents", () => {
    expect(normalizeHttpStatus("INVALID_ARGUMENT")).toBe(400);
    expect(normalizeHttpStatus("FAILED_PRECONDITION")).toBe(400);
    expect(normalizeHttpStatus("UNAUTHENTICATED")).toBe(401);
    expect(normalizeHttpStatus("PERMISSION_DENIED")).toBe(403);
    expect(normalizeHttpStatus("NOT_FOUND")).toBe(404);
    expect(normalizeHttpStatus("RESOURCE_EXHAUSTED")).toBe(429);
    expect(normalizeHttpStatus("UNAVAILABLE")).toBe(503);
    expect(normalizeHttpStatus("DEADLINE_EXCEEDED")).toBe(504);
  });

  it("matches status names case-insensitively", () => {
    expect(normalizeHttpStatus("not_found")).toBe(404);
    expect(normalizeHttpStatus("Unavailable")).toBe(503);
  });

  it("falls back for unrecognised strings", () => {
    expect(normalizeHttpStatus("BOOM")).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus("")).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus("   ")).toBe(DEFAULT_ERROR_STATUS);
  });

  it("falls back for values that are not statuses at all", () => {
    expect(normalizeHttpStatus(null)).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus(undefined)).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus({})).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus([404])).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus(Number.NaN)).toBe(DEFAULT_ERROR_STATUS);
  });

  it("honours a custom fallback", () => {
    expect(normalizeHttpStatus("nope", 503)).toBe(503);
  });

  it("ignores an invalid custom fallback rather than propagating it", () => {
    expect(normalizeHttpStatus("nope", 9999)).toBe(DEFAULT_ERROR_STATUS);
    expect(normalizeHttpStatus("nope", Number.NaN)).toBe(DEFAULT_ERROR_STATUS);
  });
});

describe("resolveErrorStatus", () => {
  it("prefers statusCode over status", () => {
    expect(resolveErrorStatus({ statusCode: 404, status: 500 })).toBe(404);
  });

  it("falls through to status when statusCode is unusable", () => {
    expect(resolveErrorStatus({ statusCode: 1006, status: 503 })).toBe(503);
    expect(resolveErrorStatus({ statusCode: null, status: 403 })).toBe(403);
    expect(resolveErrorStatus({ statusCode: undefined, status: 403 })).toBe(403);
  });

  it("resolves a Genkit-shaped error", () => {
    const err = Object.assign(new Error("model failed"), {
      status: "FAILED_PRECONDITION",
    });
    expect(resolveErrorStatus(err)).toBe(400);
  });

  it("defaults when neither field is usable", () => {
    expect(resolveErrorStatus({ statusCode: 0, status: 1006 })).toBe(DEFAULT_ERROR_STATUS);
    expect(resolveErrorStatus(new Error("plain"))).toBe(DEFAULT_ERROR_STATUS);
  });

  it("handles non-object thrown values without exploding", () => {
    expect(resolveErrorStatus("a string")).toBe(DEFAULT_ERROR_STATUS);
    expect(resolveErrorStatus(null)).toBe(DEFAULT_ERROR_STATUS);
    expect(resolveErrorStatus(undefined)).toBe(DEFAULT_ERROR_STATUS);
    expect(resolveErrorStatus(42)).toBe(DEFAULT_ERROR_STATUS);
  });

  it("honours a custom fallback", () => {
    expect(resolveErrorStatus(new Error("plain"), 502)).toBe(502);
  });
});
