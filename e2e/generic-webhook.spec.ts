import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  GENERIC_SECRET,
  genericWebhookPayload,
  signGeneric,
} from "./helpers/webhook-fixtures";

const URL = "/api/webhooks/generic";

async function sendGenericWebhook(
  request: APIRequestContext,
  payload: unknown,
  timestamp?: string,
  signature?: string,
  extraHeaders?: Record<string, string>,
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const sig = signature !== undefined ? signature : signGeneric(body, ts);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };

  if (ts !== "") {
    headers["x-secureflow-timestamp"] = ts;
  }
  if (sig !== "") {
    headers["x-secureflow-signature"] = sig;
  }

  return request.post(URL, {
    headers,
    data: Buffer.from(body),
  });
}

test.describe("Generic webhook ingestion E2E (#1524)", () => {
  test("rejects request missing X-SecureFlow-Signature", async ({ request }) => {
    const res = await sendGenericWebhook(
      request,
      genericWebhookPayload,
      Math.floor(Date.now() / 1000).toString(),
      "", // omit signature
    );
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/signature/i);
  });

  test("rejects request missing X-SecureFlow-Timestamp", async ({ request }) => {
    const res = await sendGenericWebhook(
      request,
      genericWebhookPayload,
      "", // omit timestamp
      "sha256=1234567890abcdef",
    );
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/timestamp/i);
  });

  test("rejects expired or replayed timestamp outside clock skew tolerance", async ({ request }) => {
    const expiredTs = (Math.floor(Date.now() / 1000) - 600).toString(); // 10 minutes old
    const res = await sendGenericWebhook(
      request,
      genericWebhookPayload,
      expiredTs,
      signGeneric(JSON.stringify(genericWebhookPayload), expiredTs),
    );
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/timestamp.*expired|skew|window/i);
  });

  test("rejects future timestamp outside tolerance", async ({ request }) => {
    const futureTs = (Math.floor(Date.now() / 1000) + 600).toString(); // 10 minutes in future
    const res = await sendGenericWebhook(
      request,
      genericWebhookPayload,
      futureTs,
      signGeneric(JSON.stringify(genericWebhookPayload), futureTs),
    );
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/timestamp/i);
  });

  test("rejects forged or incorrect HMAC signature", async ({ request }) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const wrongSig = "sha256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const res = await sendGenericWebhook(
      request,
      genericWebhookPayload,
      ts,
      wrongSig,
    );
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/invalid.*signature|verification failed/i);
  });

  test("rejects malformed non-JSON payload", async ({ request }) => {
    const malformed = "{ this is invalid json payload ...";
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = signGeneric(malformed, ts);
    const res = await sendGenericWebhook(
      request,
      malformed,
      ts,
      sig,
    );
    expect(res.status()).toBe(400);
  });

  test("rejects payload exceeding configured body size limit", async ({ request }) => {
    const hugePayload = {
      ...genericWebhookPayload,
      heavyData: "A".repeat(2 * 1024 * 1024), // 2 MiB
    };
    const bodyStr = JSON.stringify(hugePayload);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = signGeneric(bodyStr, ts);
    const res = await sendGenericWebhook(
      request,
      hugePayload,
      ts,
      sig,
      { "content-length": Buffer.byteLength(bodyStr).toString() },
    );
    expect(res.status()).toBe(413);
  });

  test("accepts valid signed generic webhook payload", async ({ request }) => {
    const res = await sendGenericWebhook(
      request,
      genericWebhookPayload,
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json).toBeDefined();
    expect(json.status === "ok" || json.status === "queued" || json.received === true).toBe(true);
  });
});
