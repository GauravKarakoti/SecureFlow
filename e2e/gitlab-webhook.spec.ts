import { expect, test } from "@playwright/test";
import {
  GITLAB_TOKEN,
  gitlabMergeRequestPayload,
  gitlabPipelinePayload,
  gitlabPushPayload,
} from "./helpers/webhook-fixtures";

const URL = "/api/webhooks/gitlab";

function headers(event: string, token: string = GITLAB_TOKEN) {
  return { "x-gitlab-token": token, "x-gitlab-event": event, "content-type": "application/json" };
}

test.describe("GitLab webhook", () => {
  test("rejects a request without X-Gitlab-Token", async ({ request }) => {
    const res = await request.post(URL, {
      headers: { "x-gitlab-event": "Push Hook", "content-type": "application/json" },
      data: gitlabPushPayload,
    });
    expect(res.status()).toBe(401);
  });

  test("rejects an invalid token", async ({ request }) => {
    const res = await request.post(URL, {
      headers: headers("Push Hook", "wrong-token"),
      data: gitlabPushPayload,
    });
    expect(res.status()).toBe(401);
  });

  test("rejects a missing X-Gitlab-Event header", async ({ request }) => {
    const res = await request.post(URL, {
      headers: { "x-gitlab-token": GITLAB_TOKEN, "content-type": "application/json" },
      data: gitlabPushPayload,
    });
    expect(res.status()).toBe(400);
  });

  test("rejects a body that is not valid JSON", async ({ request }) => {
    const res = await request.post(URL, {
      headers: headers("Push Hook"),
      data: Buffer.from("not-json{"),
    });
    expect(res.status()).toBe(400);
  });

  test("queues a Merge Request Hook", async ({ request }) => {
    const res = await request.post(URL, {
      headers: headers("Merge Request Hook"),
      data: gitlabMergeRequestPayload,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("queued");
  });

  test("accepts a Push Hook", async ({ request }) => {
    const res = await request.post(URL, {
      headers: headers("Push Hook"),
      data: gitlabPushPayload,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("received");
  });

  test("accepts a Pipeline Hook", async ({ request }) => {
    const res = await request.post(URL, {
      headers: headers("Pipeline Hook"),
      data: gitlabPipelinePayload,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("received");
  });

  test("ignores untracked events", async ({ request }) => {
    const res = await request.post(URL, {
      headers: headers("Tag Push Hook"),
      data: gitlabPushPayload,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("ignored");
  });
});
