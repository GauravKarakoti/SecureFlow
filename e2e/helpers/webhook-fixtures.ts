import { createHmac } from "crypto";

export const GITLAB_TOKEN = process.env.GITLAB_WEBHOOK_TOKEN || "e2e-gitlab-token";
export const BITBUCKET_SECRET = process.env.BITBUCKET_WEBHOOK_SECRET || "e2e-bitbucket-secret";
export const GITHUB_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "e2e-webhook-secret";
export const GENERIC_SECRET = process.env.GENERIC_WEBHOOK_SECRET || "e2e-generic-secret";

export const githubPushPayload = {
  ref: "refs/heads/main",
  before: "0000000000000000000000000000000000000000",
  after: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  repository: {
    id: 1296269,
    name: "secureflow-demo",
    full_name: "acme/secureflow-demo",
    owner: {
      name: "acme",
      email: "support@acme.com",
    },
    default_branch: "main",
  },
  pusher: {
    name: "dev-user",
    email: "dev@acme.com",
  },
  commits: [
    {
      id: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
      message: "feat: add api hardening",
      timestamp: "2026-11-03T20:00:00Z",
      added: ["src/api/auth.ts"],
      removed: [],
      modified: [],
    },
  ],
};

export const githubPullRequestPayload = {
  action: "opened",
  number: 42,
  pull_request: {
    id: 99887766,
    number: 42,
    state: "open",
    title: "Security scan enforcement",
    user: {
      login: "developer-bob",
      id: 45678,
    },
    head: {
      ref: "patch-security",
      sha: "0d54019a7716c17fb179d37b003fe29910d56d47",
    },
    base: {
      ref: "main",
      sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    },
  },
  repository: {
    id: 1296269,
    name: "secureflow-demo",
    full_name: "acme/secureflow-demo",
  },
  installation: {
    id: 123456,
  },
};

export const genericWebhookPayload = {
  event: "security_finding.created",
  timestamp: new Date().toISOString(),
  data: {
    findingId: "find_test_998877",
    ruleId: "SF-SEC-001",
    severity: "HIGH",
    fileLocation: "src/crypto/jwt.ts",
    details: "Hardcoded fallback signing secret detected",
  },
};

export function signGithub(body: string, secret: string = GITHUB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function signGeneric(
  body: string,
  timestamp: string,
  secret: string = GENERIC_SECRET,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

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
