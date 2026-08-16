# SecureFlow API Documentation

> *"The Professor only opens the vault through the right doors. Here are the doors."*

This document describes every HTTP route exposed under `src/app/api/`, including the expected request payloads, headers, authentication, and response shapes. Use it as the single source of truth when integrating with SecureFlow programmatically.

## Table of Contents

1. [Conventions](#conventions)
2. [Authentication](#authentication)
3. [Rate Limiting](#rate-limiting)
4. [Error Handling](#error-handling)
5. [Routes](#routes)
   - [Auth — `GET/POST /api/auth/*`](#1-auth--apiauth)
   - [Admin Export — `GET /api/admin/export`](#2-admin-export--apiadminexport)
   - [GitHub Webhook — `POST /api/webhooks/github`](#3-github-webhook--apiwebhooksgithub)
   - [Finding Explanation Stream — `GET /api/findings/[id]/explain-stream`](#4-finding-explanation-stream--apifindingsidexplain-stream)
   - [Heist OG Image — `GET /api/og/heist`](#5-heist-og-image--apiogheist)
6. [Type Reference](#type-reference)

---

## Conventions

- **Base URL**: All routes are relative to the deployed origin (e.g. `https://secure-flow-six.vercel.app`). When testing locally, use `http://localhost:9002` (the port configured in `package.json`'s `dev` script).
- **Content negotiation**: JSON routes send and expect `Content-Type: application/json`. Exceptions are explicitly called out per route (CSV, SSE, PNG).
- **Authorization**: Unless noted otherwise (e.g. the GitHub webhook), every route requires a signed-in session via NextAuth.js. See [Authentication](#authentication).
- **IDs**: Internal SecureFlow IDs are CUIDs (`cld...`). GitHub IDs are passed through as-is (numbers or strings, see the webhook payload). Never assume a GitHub ID is unique across resource types.
- **Timestamps**: All timestamps are ISO-8601 UTC strings (e.g. `2025-01-31T12:34:56.000Z`).

---

## Authentication

SecureFlow uses [NextAuth.js v5](https://authjs.dev/) with the GitHub provider. Sessions are JWT-based (1-year `maxAge`).

### Session shape

The session is augmented with SecureFlow-specific fields in `src/auth.ts`:

```ts
interface Session {
  user: {
    id: string;            // SecureFlow user ID (CUID)
    codename: string;      // Heist-themed codename (e.g. "Tokyo")
    roles: string[];       // e.g. ["USER"] or ["USER", "ADMIN"]
  };
  accessToken: string;     // GitHub OAuth access token
  error?: "RefreshAccessTokenError";
}
```

### Roles

Two roles are seeded out of the box:

| Role   | Grants |
| ------ | ------ |
| `USER` | Default. Access to the dashboard, findings, policies, audit pages, and the finding explanation stream. |
| `ADMIN`| Everything `USER` has, plus the `/api/admin/export` route and the `/admin` UI. |

### Authenticating API requests

For browser-driven requests (dashboard, share pages), the NextAuth session cookie is sent automatically — no extra headers needed.

For programmatic clients that hold a session cookie, simply include it. There is currently **no bearer-token / API-key flow**; all auth is cookie-based.

```http
GET /api/admin/export
Cookie: next-auth.session-token=<jwt>
```

---

## Rate Limiting

Selected routes are wrapped in `withRateLimit` (see `src/lib/middleware/rateLimit.ts`). Limits are keyed by the requester's IP (extracted from `x-forwarded-for`) and enforced via Upstash Redis when configured, falling back to in-memory otherwise.

When the limit is exceeded, the route returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: <windowSeconds>

{
  "error": "Too Many Requests",
  "message": "You have exceeded the rate limit. Please try again later."
}
```

| Route                          | Limit | Window |
| ------------------------------ | ----- | ------ |
| `POST /api/auth/*`             | 10    | 60s    |
| `POST /api/webhooks/github`    | 50    | 60s    |

All other routes have no explicit rate limit (Next.js / Vercel platform limits still apply).

---

## Error Handling

Routes wrapped in `withErrorHandler` (`src/lib/middleware/error-handler.ts`) return a consistent error envelope:

```ts
interface ApiError {
  success: false;
  error: string;    // machine-readable code, e.g. "UNAUTHORIZED", "DATABASE_ERROR"
  message: string;  // human-readable, with sensitive data scrubbed
}
```

### Error code mapping

| HTTP Status | `error`                | When |
| ----------- | ---------------------- | ---- |
| 400         | `BAD_REQUEST`          | Malformed input / failed Zod validation. |
| 401         | `UNAUTHORIZED`         | Missing or invalid session. |
| 403         | `FORBIDDEN`            | Authenticated but lacking role. |
| 404         | `NOT_FOUND`            | Resource doesn't exist or isn't owned by the caller. |
| 409         | `CONFLICT`             | Duplicate resource. |
| 422         | `UNPROCESSABLE_ENTITY` | Semantic validation failure. |
| 429         | `TOO_MANY_REQUESTS`    | Rate limit exceeded (see above). |
| 500         | `INTERNAL_SERVER_ERROR`| Unexpected server failure. Sensitive paths/credentials are scrubbed. |
| 500         | `DATABASE_ERROR`       | Prisma/Postgres failure. Schema details redacted. |

**Sensitive-data scrubbing**: error messages are passed through `scrubSensitiveData()` before being returned to the client. This redacts connection strings, file paths, and `*=*` env-var patterns. The original (unredacted) error is logged server-side via the structured `logger`.

---

## Routes

### 1. Auth — `/api/auth/*`

**File**: `src/app/api/auth/[...nextauth]/route.ts`
**Handler**: NextAuth.js v5 `handlers` (re-exported).

This is the catch-all NextAuth route. It handles the OAuth dance with GitHub, JWT issuance/refresh, and session retrieval. You generally don't call it directly — the `<LoginButton>` component and NextAuth client hooks do.

| Method | Path                  | Purpose |
| ------ | --------------------- | ------- |
| `GET`  | `/api/auth/signin`    | Renders the GitHub sign-in flow (redirects to `/login` per `auth.config.ts`). |
| `POST` | `/api/auth/callback/github` | OAuth callback from GitHub. Creates the user + `USER` role on first login, assigns a random heist codename. |
| `GET`  | `/api/auth/session`   | Returns the current session JSON (or `null` if signed out). |
| `POST` | `/api/auth/signout`   | Destroys the session. |

#### `GET /api/auth/session`

**Auth**: None.

**200 OK** (signed in):
```json
{
  "user": {
    "id": "cld1a2b3c4d5e6f7g8h9i0j1",
    "codename": "Tokyo",
    "roles": ["USER"]
  },
  "accessToken": "gho_abcdef...",
  "expires": "2026-01-31T12:34:56.000Z"
}
```

**200 OK** (signed out):
```json
null
```

> The `POST` handler is rate-limited (10 req / 60s per IP) to prevent brute-forcing the OAuth callback. The `GET` handler is not.

---

### 2. Admin Export — `/api/admin/export`

**File**: `src/app/api/admin/export/route.ts`

Exports all `AuditLog` rows as a CSV file. Admin-only.

#### Request

```http
GET /api/admin/export
Cookie: next-auth.session-token=<jwt>
```

**Auth**: Requires an authenticated session **and** the `ADMIN` role.
**Rate limit**: None (admin-only).
**Query params**: None.
**Body**: None.

#### Responses

**200 OK** — CSV attachment. Headers:

```http
Content-Type: text/csv
Content-Disposition: attachment; filename="audit_logs_export.csv"
```

Body (example):

```csv
id,userId,action,resource,decision,metadata,timestamp
cld1...,cld2...,Scan Triggered,owner/repo#42,,{"action":"opened","head_sha":"abc123"},2025-01-31T12:34:56.000Z
cld3...,cld4...,Policy Evaluation,owner/repo#42,PASS,{"findingsCount":0},2025-01-31T12:35:02.000Z
```

CSV rules:
- Column order: `id,userId,action,resource,decision,metadata,timestamp`.
- The `metadata` column is the JSON value serialized to a single line.
- Fields containing `,`, `"`, or `\n` are double-quoted; embedded `"` are escaped as `""` (RFC 4180).
- `null` / `undefined` values become empty strings.

**401 Unauthorized**:
```json
{ "error": "Unauthorized access" }
```

**404 Not Found** — no audit logs exist yet:
```
No data available
```
*(Plain text, not JSON — this route predates the standardized error envelope.)*

**500 Internal Server Error**:
```json
{ "error": "Internal Server Error" }
```

---

### 3. GitHub Webhook — `/api/webhooks/github`

**File**: `src/app/api/webhooks/github/route.ts`

Receives GitHub App webhook deliveries. This is the heart of SecureFlow — it ingests PR/installation events, runs the ArmorIQ scanner + AI reasoner, posts the security report comment, and persists everything to the DB.

#### Request

```http
POST /api/webhooks/github
Content-Type: application/json
X-GitHub-Event: pull_request
X-GitHub-Delivery: <uuid>
X-Hub-Signature-256: sha256=<hex-hmac>
```

**Auth**: HMAC-SHA256 signature verification using `GITHUB_WEBHOOK_SECRET`.
**Rate limit**: 50 req / 60s per IP.
**Body**: The raw GitHub webhook payload (see GitHub's official event docs for the full schema — SecureFlow validates a subset with Zod).

#### Signature verification

The `X-Hub-Signature-256` header must be `sha256=` + the hex HMAC of the raw request body keyed by `GITHUB_WEBHOOK_SECRET`. Verified with `crypto.timingSafeEqual` to prevent timing attacks. Missing/invalid signature → `401`.

#### Events handled

| `X-GitHub-Event` | `action` | Behavior |
| ---------------- | -------- | -------- |
| `pull_request` | `opened`, `synchronize`, `reopened` | Full scan pipeline (below). |
| `pull_request` | `closed` | Records merge/closure state for leaderboard scoring. No scan. |
| `installation` | `created` | Links the installer's GitHub account (via `sender.id`) and bulk-inserts selected repos in chunks of 50. |
| `installation_repositories` | `added` | Inserts newly-added repos for an existing installation. |
| *(anything else)* | — | Returns `200 { "message": "Event not tracked" }`. |

#### Payload schema (validated subset)

SecureFlow uses a Zod schema that's intentionally permissive (`.passthrough()`) so GitHub can add fields without breaking the webhook. The validated shape:

```ts
{
  action?: string;
  pull_request?: {
    id: number | string;
    number: number;
    title?: string;
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    head?: { sha: string };
    user?: { login: string; avatar_url?: string };
  };
  repository?: {
    id: number | string;
    full_name: string;
    name?: string;
    owner?: { login: string };
  };
  installation?: { id: number | string };
  repositories?: Repository[];      // installation event
  repositories_added?: Repository[]; // installation_repositories event
  sender?: { id: number | string };
}
```

#### Responses

All responses are JSON.

**200** — Event ignored or PR closed/merge recorded:
```json
{ "message": "Event not tracked" }
// or
{ "success": true, "message": "PR marked merged" }
```

**202** — Duplicate delivery (idempotency guard) or rate-limit-failed scan:
```json
{ "message": "Webhook already processed" }
// or
{ "success": false, "message": "Rate limit exceeded, check run updated to failure" }
```

**200** — Successful scan:
```json
{
  "success": true,
  "decision": "PASS" | "REVIEW REQUIRED" | "BLOCKED",
  "findingCount": 0
}
```

**200** — Scan failed (AI timeout / API error), check run marked neutral:
```json
{
  "success": false,
  "error": "<error message>",
  "fallback": true
}
```

**400 Bad Request**:
```json
{ "error": "Invalid payload structure" }
// or
{ "error": "Missing or invalid x-hub-signature-256 header" }
// or
{ "message": "No GitHub App installation ID found" }
```

**401 Unauthorized**:
```json
{ "error": "Invalid GitHub webhook signature" }
```

**429 Too Many Requests**: See [Rate Limiting](#rate-limiting).

**500 Internal Server Error**: `GITHUB_WEBHOOK_SECRET` not set, or unexpected failure (wrapped by `withErrorHandler`).

#### Scan pipeline side-effects

For a tracked `pull_request` event, the handler:

1. Creates a GitHub Check Run named `SecureFlow Scan` (status: `in_progress`).
2. Fetches the PR's changed files (capped at **150 files** — beyond that, only the first 150 are scanned and a warning is posted).
3. Posts a `⏳ SecureFlow AI Security Scan` placeholder comment.
4. Reads `.secureflowignore` from the repo root (if present) for custom ignore patterns.
5. Runs `scanner.scanPullRequest()` → `developerReceivesAISecurityExplanations()` per finding → `iq.evaluateFindings()` for the policy decision.
6. Updates the Check Run conclusion: `success` (PASS), `action_required` (REVIEW REQUIRED), or `failure` (BLOCKED).
7. Updates the placeholder comment with the full AI Security Report (or a ✅ "no vulnerabilities" message).
8. Persists `PullRequest`, `ScanResult`, and `Finding` rows.

#### Required environment variables

```
GITHUB_WEBHOOK_SECRET   # HMAC secret configured in the GitHub App settings
GITHUB_APP_ID           # SecureFlow GitHub App ID
GITHUB_PRIVATE_KEY      # PEM private key (\n-escaped)
```

---

### 4. Finding Explanation Stream — `/api/findings/[id]/explain-stream`

**File**: `src/app/api/findings/[id]/explain-stream/route.ts`

Streams a live-regenerated AI explanation for a single finding as Server-Sent Events. This powers the "regenerate explanation" UX in the findings dashboard — the text appears token-by-token instead of waiting for the full response.

#### Request

```http
GET /api/findings/cld1a2b3.../explain-stream
Cookie: next-auth.session-token=<jwt>
Accept: text/event-stream
```

**Auth**: Requires an authenticated session. The finding must belong to a scan result, on a pull request, on a repository owned by the signed-in user (ownership checked via Prisma relation traversal).
**Rate limit**: None.
**Runtime**: `force-dynamic`.

#### Path parameters

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | The SecureFlow `Finding.id` (CUID). |

#### Query parameters

None.

#### Response

**200 OK** — Server-Sent Events stream.

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Each SSE frame is `data: <json>\n\n`. Three event types:

**Chunk** (streaming text):
```json
{ "type": "chunk", "text": "This finding indicates..." }
```

**Done** (final result — also persisted to the DB):
```json
{
  "type": "done",
  "result": {
    "explanation": "Full explanation text...",
    "remediationSuggestions": "Remediation text...",
    "promptInjectionSuspected": false
  }
}
```

**Error**:
```json
{ "type": "error", "message": "AI generation failed." }
```

> On `done`, the handler persists `explanation`, `remediation`, and `promptInjectionSuspected` back to the `Finding` row. A failed persist is non-fatal — the client already has the streamed result.

**401 Unauthorized**:
```json
{ "error": "Unauthorized" }
```

**404 Not Found** — finding doesn't exist or isn't owned by the caller:
```json
{ "error": "Finding not found" }
```

#### Client consumption example

```ts
const res = await fetch(`/api/findings/${id}/explain-stream`, {
  credentials: "include",
});
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += value;
  const frames = buffer.split("\n\n");
  buffer = frames.pop() ?? "";
  for (const frame of frames) {
    const json = JSON.parse(frame.replace(/^data: /, ""));
    if (json.type === "chunk") appendText(json.text);
    if (json.type === "done")  finalize(json.result);
    if (json.type === "error") showError(json.message);
  }
}
```

---

### 5. Heist OG Image — `/api/og/heist`

**File**: `src/app/api/og/heist/route.tsx`

Generates a 1200×630 PNG Open Graph image for the heist share page (`/share/heist`). Used by social-media crawlers when a share link is posted.

#### Request

```http
GET /api/og/heist?project=The%20Royal%20Mint&score=92&rank=S&findingsCount=3
```

**Auth**: None (public — must be reachable by social crawlers).
**Rate limit**: None.
**Runtime**: `edge` (Vercel Edge Runtime, via `next/og`).

#### Query parameters

| Name | Type | Required | Default | Description |
| ---- | ---- | -------- | ------- | ----------- |
| `project` | string | no | `Classified Target` | Target repository name shown on the card. |
| `score` | number | no | — | Security score (0–100). Drives the tier if `rank` is absent. |
| `rank` | string | no | derived from `score` | One of `S`, `A`, `B`, `C`, `D`. Overrides the score-derived tier. |
| `findingsCount` | number | no | — | Number of findings to display. |

#### Tier resolution

If `rank` is provided and valid, it's used directly. Otherwise, `score` is mapped:

| Score range | Tier | Color | Quote |
| ----------- | ---- | ----- | ----- |
| 90–100 | S | `#facc15` (gold) | Ghost protocol. Zero traces left behind. |
| 75–89  | A | `#ef4444` (red) | The vault is empty. Clean getaway. |
| 60–74  | B | `#fb923c` (orange) | Job done. A few loose ends remain. |
| 40–59  | C | `#a3a3a3` (grey) | Amateur hour. The vault noticed. |
| 0–39   | D | `#71717a` (dark grey) | Blown cover. Back to the drawing board. |

#### Responses

**200 OK** — PNG image.

```http
Content-Type: image/png
Cache-Control: public, max-age=31536000, immutable
```

*(Standard `next/og` caching headers — the image is deterministic for a given query string.)*

**500 Internal Server Error** — image generation failure:
```
Failed to generate image
```
*(Plain text, not JSON.)*

---

## Type Reference

These are the persisted data shapes referenced throughout the routes above. All are defined in `prisma/schema.prisma`.

### `Repository`
```ts
{
  id: string;          // CUID
  githubId: bigint;    // GitHub repo ID
  fullName: string;    // "owner/name"
  owner: string;
  isActive: boolean;
  userId: string;      // SecureFlow owner
}
```

### `PullRequest`
```ts
{
  id: string;          // CUID
  githubId: bigint;
  prNumber: number;
  title: string;
  state: string;       // "open" | "closed" | "merged"
  status: string;      // "PASS" | "REVIEW_REQUIRED" | "BLOCKED"
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  repositoryId: string;
}
```

### `ScanResult`
```ts
{
  id: string;
  pullRequestId: string;
  riskScore: number;
  policyDecision: string;  // "PASS" | "REVIEW_REQUIRED" | "BLOCKED"
  createdAt: string;       // ISO timestamp
}
```

### `Finding`
```ts
{
  id: string;
  scanResultId: string;
  type: string;            // "Secret" | "Vulnerability" | "Misconfig" | ...
  severity: string;        // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  fileLocation: string;
  codeSnippet: string | null;
  explanation: string | null;
  remediation: string | null;
  promptInjectionSuspected: boolean;
  createdAt: string;       // ISO timestamp
}
```

### `AuditLog`
```ts
{
  id: string;
  userId: string | null;
  action: string;          // "Scan Triggered" | "Policy Evaluation" | ...
  resource: string;        // "owner/repo#42"
  decision: string | null; // "PASS" | "REVIEW_REQUIRED" | "BLOCKED" | "FAIL"
  metadata: object | null; // arbitrary JSON
  timestamp: string;       // ISO timestamp
}
```

### `WebhookEvent`
```ts
{
  id: string;
  deliveryId: string;      // X-GitHub-Delivery UUID, unique
  repositoryId: string | null;
  pullRequestId: string | null;
  createdAt: string;
}
```

---

## Environment Variables

Required across the API surface:

| Variable | Used by | Purpose |
| -------- | ------- | ------- |
| `GITHUB_CLIENT_ID` | `/api/auth/*` | GitHub OAuth client ID. |
| `GITHUB_CLIENT_SECRET` | `/api/auth/*` | GitHub OAuth client secret. |
| `GITHUB_APP_ID` | `/api/webhooks/github` | SecureFlow GitHub App ID. |
| `GITHUB_PRIVATE_KEY` | `/api/webhooks/github` | App PEM private key (`\n`-escaped). |
| `GITHUB_WEBHOOK_SECRET` | `/api/webhooks/github` | HMAC secret for webhook signature verification. |
| `NEXT_PUBLIC_APP_URL` | `/share/heist` (OG meta) | Public origin for absolute OG image URLs. |
| `DATABASE_URL` | All DB-backed routes | Postgres connection string. |
| `UPSTASH_REDIS_REST_URL` | `withRateLimit` | (Optional) Upstash Redis for distributed rate limiting. |
| `UPSTASH_REDIS_REST_TOKEN` | `withRateLimit` | (Optional) Upstash Redis token. |

---

## Changelog

| Date | Change |
| ---- | ------ |
| 2025-01-31 | Initial API documentation covering all 5 route groups. |

---
