/**
 * Regression tests for the status handling in `withErrorHandler`.
 *
 * These live in their own file on purpose: `error-handler.test.ts` mocks
 * `NextResponse.json` so it can assert on the arguments, which means a status
 * that the real `Response` constructor rejects never surfaces there. The bug in
 * #526 — a `RangeError` thrown from inside the error handler — is only
 * observable against the genuine implementation, so nothing is mocked here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withErrorHandler, AppError } from "./error-handler";

describe("withErrorHandler status normalisation (real NextResponse)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const throwing = (err: unknown) =>
    withErrorHandler(async () => {
      throw err;
    });

  it("does not throw on a Genkit-style string status", async () => {
    const err = Object.assign(new Error("model failed"), {
      status: "FAILED_PRECONDITION",
    });

    const res = await throwing(err)();

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("maps a Genkit UNAVAILABLE onto 503", async () => {
    const err = Object.assign(new Error("backend down"), { status: "UNAVAILABLE" });

    const res = (await throwing(err)()) as Response;

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: "SERVICE_UNAVAILABLE",
    });
  });

  it("does not throw on a WebSocket close code", async () => {
    const err = Object.assign(new Error("socket died"), { statusCode: 1006 });

    const res = (await throwing(err)()) as Response;

    expect(res.status).toBe(500);
  });

  it("does not throw on a zero status from an aborted request", async () => {
    const err = Object.assign(new Error("aborted"), { status: 0 });

    const res = (await throwing(err)()) as Response;

    expect(res.status).toBe(500);
  });

  it("does not throw on a fractional status", async () => {
    const err = Object.assign(new Error("weird"), { statusCode: 404.5 });

    const res = (await throwing(err)()) as Response;

    expect(res.status).toBe(500);
  });

  it("still honours a genuine numeric status", async () => {
    const res = (await throwing(new AppError("nope", 403))()) as Response;

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: "AppError",
      message: "nope",
    });
  });

  it("handles a non-Error thrown value", async () => {
    const res = (await throwing("just a string")()) as Response;

    expect(res.status).toBe(500);
  });

  it("does not echo internal error class names back to the client", async () => {
    const err = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      statusCode: 409,
      code: "P2002",
    });

    const res = (await throwing(err)()) as Response;
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("CONFLICT");
    expect(JSON.stringify(body)).not.toContain("Prisma");
  });

  it("does not spread arbitrary error properties into the log payload", async () => {
    const err = Object.assign(new Error("query failed"), {
      statusCode: 500,
      // A Prisma-style meta payload carrying real parameter values.
      internalToken: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    await throwing(err)();

    const logged = consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(logged).not.toContain("internalToken");
    expect(logged).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
