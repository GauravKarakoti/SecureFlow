import { createHmac } from "crypto";

export const GITLAB_TOKEN = process.env.GITLAB_WEBHOOK_TOKEN || "e2e-gitlab-token";
export const BITBUCKET_SECRET = process.env.BITBUCKET_WEBHOOK_SECRET || "e2e-bitbucket-secret";

export const gitlabMergeRequestPayload = {
  object_kind: "merge_request",
  project: { id: 101, path_with_namespace: "acme/secureflow-demo" },
  object_attributes: { id: 7, iid: 3, action: "open", state: "opened" },
};

export const gitlabPushPayload = {
  object_kind: "push",
  project_id: 101,
  ref: "refs/heads/main",
};

export const gitlabPipelinePayload = {
  object_kind: "pipeline",
  project: { id: 101 },
  object_attributes: { id: 55, status: "success" },
};

export const bitbucketPushPayload = {
  repository: { full_name: "acme/secureflow-demo" },
  push: { changes: [{ new: { type: "branch", name: "main" } }] },
};

export const bitbucketPullRequestPayload = {
  repository: { full_name: "acme/secureflow-demo" },
  pullrequest: { id: 12, title: "Fix finding" },
};

export function signBitbucket(body: string, secret: string = BITBUCKET_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}
