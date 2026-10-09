import { describe, it, expect } from "vitest";
import { readBoundedRequestBody } from "./request-body";

describe("readBoundedRequestBody", () => {
  it("reads small text payload within limits", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload, "utf-8")),
      },
      body: payload,
    });

    const body = await readBoundedRequestBody(req, 1024);
    expect(body).toBe(payload);
  });

  it("reads payload exactly at the byte limit", async () => {
    const payload = "a".repeat(100);
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": "100",
      },
      body: payload,
    });

    const body = await readBoundedRequestBody(req, 100);
    expect(body).toBe(payload);
  });

  it("rejects immediately with 413 when Content-Length exceeds limit", async () => {
    const payload = JSON.stringify({ test: "data" });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1000",
      },
      body: payload,
    });

    await expect(readBoundedRequestBody(req, 500)).rejects.toMatchObject({
      statusCode: 413,
      message: "Request payload exceeds maximum allowed size",
    });
  });

  it("rejects streaming payload when chunks exceed limit without Content-Length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(300)));
        controller.enqueue(new TextEncoder().encode("b".repeat(300)));
        controller.close();
      },
    });

    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
      // @ts-expect-error Node fetch duplex option
      duplex: "half",
    });

    await expect(readBoundedRequestBody(req, 500)).rejects.toMatchObject({
      statusCode: 413,
      message: "Request payload exceeds maximum allowed size",
    });
  });
});
