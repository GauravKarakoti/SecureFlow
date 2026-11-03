import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  GITHUB_SECRET,
  githubPullRequestPayload,
  githubPushPayload,
  signGithub,
} from "./helpers/webhook-fixtures";

const URL = "/api/webhooks/github";

async function sendGithubWebhook(
  request: APIRequestContext,
  event: string | null,
  deliveryId: string | null,
  payload: unknown,
  customSignature?: string,
  extraHeaders?: Record<string, string>,
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };

  if (event !== null) {
    headers["x-github-event"] = event;
  }
  if (deliveryId !== null) {
    headers["x-github-delivery"] = deliveryId;
  }
  if (customSignature !== undefined) {
    if (customSignature !== "") {
      headers["x-hub-signature-256"] = customSignature;
    }
  } else {
    headers["x-hub-signature-256"] = signGithub(body);
  }

  return request.post(URL, {
    headers,
    data: Buffer.from(body),
  });
}

test.describe("GitHub webhook ingestion E2E (#1524)", () => {
  test("rejects request missing delivery ID (X-GitHub-Delivery header)", async ({ request }) => {
    const res = await sendGithubWebhook(
      request,
      "push",
      null, // missing delivery ID
      githubPushPayload,
    );
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/x-github-delivery/i);
  });

  test("rejects request missing signature header", async ({ request }) => {
    const res = await sendGithubWebhook(
      request,
      "push",
      "e2e-delivery-missing-sig-1",
      githubPushPayload,
      "", // explicitly omit signature header
    );
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/x-hub-signature-256/i);
  });

  test("rejects request with invalid signature", async ({ request }) => {
    const res = await sendGithubWebhook(
      request,
      "push",
      "e2e-delivery-invalid-sig-2",
      githubPushPayload,
      "sha256=invalidfakesignaturehexstring1234567890abcdef1234567890abcdef",
    );
    expect(res.status()).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/invalid.*signature/i);
  });

  test("rejects malformed non-JSON payload with 400 Bad Request", async ({ request }) => {
    const malformed = "{ this is not valid json :(";
    const sig = signGithub(malformed);
    const res = await sendGithubWebhook(
      request,
      "push",
      "e2e-delivery-malformed-3",
      malformed,
      sig,
    );
    expect(res.status()).toBe(400);
  });

  test("rejects payloads that exceed maximum size limits (413 Payload Too Large)", async ({
    request,
  }) => {
    const hugeBody = JSON.stringify({
      ...githubPushPayload,
      bloat: "x".repeat(3 * 1024 * 1024), // 3 MiB exceeds standard 1-2 MiB limit
    });
    const sig = signGithub(hugeBody);
    const res = await sendGithubWebhook(
      request,
      "push",
      "e2e-delivery-oversize-4",
      hugeBody,
      sig,
      { "content-length": Buffer.byteLength(hugeBody).toString() },
    );
    expect(res.status()).toBe(413);
  });

  test("accepts ping event without queueing work", async ({ request }) => {
    const pingPayload = { zen: "Design for failure.", hook_id: 123456 };
    const res = await sendGithubWebhook(
      request,
      "ping",
      "e2e-delivery-ping-5",
      pingPayload,
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.message).toMatch(/ping received/i);
  });

  test("handles valid push event successfully", async ({ request }) => {
    const res = await sendGithubWebhook(
      request,
      "push",
      "e2e-delivery-push-6",
      githubPushPayload,
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("queued");
  });

  test("handles valid pull_request event successfully", async ({ request }) => {
    const res = await sendGithubWebhook(
      request,
      "pull_request",
      "e2e-delivery-pr-7",
      githubPullRequestPayload,
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("queued");
  });

  test("handles branch protection mutation notification gracefully", async ({ request }) => {
    const branchProtectionPayload = {
      action: "created",
      rule: { name: "main" },
      repository: { full_name: "acme/secureflow-demo" },
    };
    const res = await sendGithubWebhook(
      request,
      "branch_protection_rule",
      "e2e-delivery-branch-rule-8",
      branchProtectionPayload,
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.message).toMatch(/branch protection/i);
  });

  test("safely ignores untracked GitHub events with 200 OK", async ({ request }) => {
    const untrackedPayload = { action: "starred", sender: { login: "alice" } };
    const res = await sendGithubWebhook(
      request,
      "watch",
      "e2e-delivery-untracked-9",
      untrackedPayload,
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.message).toMatch(/event not tracked/i);
  });
});
