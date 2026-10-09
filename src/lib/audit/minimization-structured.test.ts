/**
 * Regression tests for structured values in audit metadata (#528).
 *
 * `sanitizeAuditMetadata` handled scalars, arrays and plain objects, and let
 * everything else fall into the plain-object branch. Because `Object.entries()`
 * only sees own enumerable properties, a `Date`, `Map`, `Set` or `Error`
 * serialised to `{}` and a `Buffer` exploded into a per-byte object — all
 * silently, since the audit row was still written.
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditMetadata, sanitizeAuditLogInput } from "./minimization";

describe("sanitizeAuditMetadata — dates", () => {
  it("keeps a Date as an ISO string instead of collapsing it to {}", () => {
    const result = sanitizeAuditMetadata({ occurredAt: new Date("2026-01-01T00:00:00.000Z") });

    expect(result).toEqual({ occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("labels an invalid Date rather than emitting null", () => {
    expect(sanitizeAuditMetadata({ at: new Date("nonsense") })).toEqual({ at: "[Invalid Date]" });
  });

  it("handles a Date nested inside an array", () => {
    const result = sanitizeAuditMetadata([new Date("2026-06-01T12:00:00.000Z")]);

    expect(result).toEqual(["2026-06-01T12:00:00.000Z"]);
  });
});

describe("sanitizeAuditMetadata — collections", () => {
  it("keeps Map entries", () => {
    const result = sanitizeAuditMetadata({ counts: new Map([["critical", 2]]) });

    expect(result).toEqual({ counts: { critical: 2 } });
  });

  it("redacts sensitive keys inside a Map", () => {
    const result = sanitizeAuditMetadata({
      headers: new Map([
        ["authorization", "Bearer abc123def456ghi789"],
        ["accept", "application/json"],
      ]),
    }) as { headers: Record<string, unknown> };

    expect(result.headers.authorization).toBe("[REDACTED]");
    expect(result.headers.accept).toBe("application/json");
  });

  it("keeps Set values as an array", () => {
    expect(sanitizeAuditMetadata({ ids: new Set([1, 2, 3]) })).toEqual({ ids: [1, 2, 3] });
  });

  it("sanitises values inside a Set", () => {
    const result = sanitizeAuditMetadata({
      tokens: new Set(["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
    }) as { tokens: string[] };

    expect(result.tokens[0]).toContain("[REDACTED]");
  });
});

describe("sanitizeAuditMetadata — errors and binary", () => {
  it("keeps an Error's name and message", () => {
    const result = sanitizeAuditMetadata({ cause: new Error("connection refused") });

    expect(result).toEqual({ cause: { name: "Error", message: "connection refused" } });
  });

  it("redacts a secret embedded in an Error message", () => {
    const result = sanitizeAuditMetadata({
      cause: new Error("auth failed for ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    }) as { cause: { message: string } };

    expect(result.cause.message).toContain("[REDACTED]");
    expect(result.cause.message).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("summarises a Buffer instead of expanding it byte by byte", () => {
    const result = sanitizeAuditMetadata({ body: Buffer.from("hello world") });

    expect(result).toEqual({ body: "[Binary: 11 bytes]" });
  });

  it("summarises a typed array", () => {
    expect(sanitizeAuditMetadata({ raw: new Uint8Array(4) })).toEqual({
      raw: "[Binary: 4 bytes]",
    });
  });
});

describe("sanitizeAuditMetadata — other built-ins", () => {
  it("stringifies a RegExp", () => {
    expect(sanitizeAuditMetadata({ pattern: /ghp_\w+/i })).toEqual({ pattern: "/ghp_\\w+/i" });
  });

  it("strips credentials from a URL", () => {
    const result = sanitizeAuditMetadata({
      target: new URL("https://user:hunter2@example.com/webhook"),
    }) as { target: string };

    expect(result.target).not.toContain("hunter2");
    expect(result.target).toContain("[CREDENTIALS_REDACTED]");
  });

  it("keeps a plain URL readable", () => {
    const result = sanitizeAuditMetadata({ target: new URL("https://example.com/hook") });

    expect(result).toEqual({ target: "https://example.com/hook" });
  });

  it("stringifies a BigInt with its suffix", () => {
    expect(sanitizeAuditMetadata({ id: BigInt("90071992547409911") })).toEqual({
      id: "90071992547409911n",
    });
  });

  it("labels a function rather than dropping it", () => {
    expect(sanitizeAuditMetadata({ cb: function handler() {} })).toEqual({
      cb: "[Function: handler]",
    });
  });

  it("stringifies non-finite numbers that JSON cannot represent", () => {
    expect(sanitizeAuditMetadata({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toEqual({
      a: "NaN",
      b: "Infinity",
    });
  });
});

describe("sanitizeAuditMetadata — circular references", () => {
  it("reports a self-reference once instead of re-expanding it", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(sanitizeAuditMetadata(node)).toEqual({ name: "root", self: "[CIRCULAR]" });
  });

  it("handles a two-step cycle", () => {
    const a: Record<string, unknown> = { id: "a" };
    const b: Record<string, unknown> = { id: "b", a };
    a.b = b;

    expect(sanitizeAuditMetadata(a)).toEqual({
      id: "a",
      b: { id: "b", a: "[CIRCULAR]" },
    });
  });

  it("still expands two sibling references to the same object", () => {
    const shared = { value: 1 };

    expect(sanitizeAuditMetadata({ first: shared, second: shared })).toEqual({
      first: { value: 1 },
      second: { value: 1 },
    });
  });

  it("does not hang on a cycle nested inside an array", () => {
    const node: Record<string, unknown> = { id: 1 };
    node.children = [node];

    expect(() => sanitizeAuditMetadata(node)).not.toThrow();
    expect(sanitizeAuditMetadata(node)).toEqual({ id: 1, children: ["[CIRCULAR]"] });
  });
});

describe("sanitizeAuditMetadata — size caps", () => {
  it("truncates an oversized array and says how much was dropped", () => {
    const result = sanitizeAuditMetadata(Array.from({ length: 150 }, (_, i) => i)) as unknown[];

    expect(result).toHaveLength(101);
    expect(result[100]).toBe("[TRUNCATED: 50 more]");
  });

  it("truncates an object with too many keys", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 120; i += 1) wide[`k${i}`] = i;

    const result = sanitizeAuditMetadata(wide) as Record<string, unknown>;

    expect(Object.keys(result)).toHaveLength(101);
    expect(result["[TRUNCATED]"]).toBe("20 more keys");
  });

  it("truncates an absurdly long string", () => {
    const result = sanitizeAuditMetadata({ blob: "the quick brown fox ".repeat(500) }) as {
      blob: string;
    };

    expect(result.blob.endsWith("…[TRUNCATED]")).toBe(true);
    expect(result.blob.length).toBeLessThan(5000);
  });

  it("caps a long fingerprint-shaped string too", () => {
    const result = sanitizeAuditMetadata({ blob: "a".repeat(5000) }) as { blob: string };

    expect(result.blob.endsWith("…[TRUNCATED]")).toBe(true);
  });

  it("leaves a real fingerprint untouched", () => {
    const fingerprint = "a3f".repeat(20);

    expect(sanitizeAuditMetadata({ fingerprint })).toEqual({ fingerprint });
  });

  it("leaves a normal-length string alone", () => {
    expect(sanitizeAuditMetadata({ note: "looks fine" })).toEqual({ note: "looks fine" });
  });
});

describe("sanitizeAuditMetadata — sensitive key normalisation", () => {
  it.each([
    "api_key",
    "API-KEY",
    "apiKey",
    "access_token",
    "accessToken",
    "refresh_token",
    "client_secret",
    "private_key",
    "webhook_secret",
    "github_token",
    "Github Token",
  ])("redacts %s", (key) => {
    const result = sanitizeAuditMetadata({ [key]: "value-that-should-vanish" }) as Record<
      string,
      unknown
    >;

    expect(result[key]).toBe("[REDACTED]");
  });

  it("leaves non-sensitive keys alone", () => {
    expect(sanitizeAuditMetadata({ repositoryId: "repo-1" })).toEqual({ repositoryId: "repo-1" });
  });
});

describe("sanitizeAuditLogInput with structured metadata", () => {
  it("preserves a timestamp through the full input sanitiser", () => {
    const result = sanitizeAuditLogInput({
      action: "finding triage",
      resource: "acme/widgets:abc123",
      decision: "RESOLVED",
      metadata: {
        triagedAt: new Date("2026-03-04T05:06:07.000Z"),
        api_key: "should-vanish",
        counts: new Map([["high", 3]]),
      },
    });

    expect(result.action).toBe("FINDING TRIAGE");
    expect(result.metadata).toEqual({
      triagedAt: "2026-03-04T05:06:07.000Z",
      api_key: "[REDACTED]",
      counts: { high: 3 },
    });
  });

  it("produces JSON-serialisable output for Prisma", () => {
    const result = sanitizeAuditLogInput({
      action: "webhook",
      metadata: { at: new Date("2026-01-01T00:00:00.000Z"), body: Buffer.from("hi") },
    });

    expect(() => JSON.stringify(result.metadata)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result.metadata))).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      body: "[Binary: 2 bytes]",
    });
  });
});
