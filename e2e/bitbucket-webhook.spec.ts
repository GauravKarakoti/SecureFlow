import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  bitbucketPullRequestPayload,
  bitbucketPushPayload,
  signBitbucket,
} from "./helpers/webhook-fixtures";

const URL = "/api/webhooks/bitbucket";

async function send(
  request: APIRequestContext,
  event: string | null,
  payload: unknown,
  signature?: string,
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (event) headers["x-event-key"] = event;
  headers["x-hub-signature"] = signature ?? signBitbucket(body);
  return request.post(URL, { headers, data: Buffer.from(body) });
}

test.describe("Bitbucket webhook", () => {
  test("rejects a request without a signature", async ({ request }) => {
    const res = await request.post(URL, {
      headers: { "x-event-key": "repo:push", "content-type": "application/json" },
      data: JSON.stringify(bitbucketPushPayload),
    });
    expect(res.status()).toBe(401);
  });

  test("rejects an invalid signature", async ({ request }) => {
    const res = await send(request, "repo:push", bitbucketPushPayload, signBitbucket("{}", "x"));
    expect(res.status()).toBe(401);
  });

  test("rejects a validly signed body that is not JSON", async ({ request }) => {
    const res = await send(request, "repo:push", "not-json{");
    expect(res.status()).toBe(400);
  });

  test("rejects a missing X-Event-Key header", async ({ request }) => {
    const res = await send(request, null, bitbucketPushPayload);
    expect(res.status()).toBe(400);
  });

  test("accepts a signed repo:push", async ({ request }) => {
    const res = await send(request, "repo:push", bitbucketPushPayload);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("received");
  });

  test("queues a signed pullrequest:created", async ({ request }) => {
    const res = await send(request, "pullrequest:created", bitbucketPullRequestPayload);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("queued");
  });

  test("acknowledges pullrequest:fulfilled", async ({ request }) => {
    const res = await send(request, "pullrequest:fulfilled", bitbucketPullRequestPayload);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("received");
  });

  test("ignores untracked events", async ({ request }) => {
    const res = await send(request, "pullrequest:rejected", bitbucketPullRequestPayload);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("ignored");
  });
});
