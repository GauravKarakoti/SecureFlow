# SecureFlow API Documentation

> _"The Professor only opens the vault through the right doors. Here are the doors."_

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
   - [Asynchronous SBOM Scan — `POST /api/sbom/scan`](#6-asynchronous-sbom-scan--apisbomscan)
   - [SBOM Scan Status — `GET /api/sbom/scan/status/[jobId]`](#7-sbom-scan-status--apisbomscanstatusjobid)
   - [Real-Time Voice Alerts Stream — `GET /api/voice-alerts/stream`](#8-real-time-voice-alerts-stream--apivoice-alertsstream)
6. [Type Reference](#type-reference)

---

## Interactive playground

Prefer to try a route rather than read about it? `/docs/api-playground` renders every operation from [`openapi.yaml`](../openapi.yaml) with Swagger UI, so you can send real requests from the browser. Run `npm run dev` and open <http://localhost:9002/docs/api-playground>.

The spec is served by `GET /api/openapi`, which reads the committed `openapi.yaml` directly — the playground therefore cannot drift from the specification the way a hand-maintained page can.

Two caveats. Session-authenticated routes work once you are signed in, because the browser sends the session cookie with same-origin requests. Webhook routes verify an HMAC signature that the browser cannot compute, so send those with `curl` using the examples below.

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
    id: string; // SecureFlow user ID (CUID)
    codename: string; // Heist-themed codename (e.g. "Tokyo")
    roles: string[]; // e.g. ["USER"] or ["USER", "ADMIN"]
  };
  error?: "RefreshAccessTokenError";
}
```

The session is served to the browser, so it carries no provider credentials.
The GitHub OAuth access and refresh tokens stay in the encrypted session
cookie; server code that needs to call GitHub as the user reads the access
token with `getSessionWithGitHubToken()` from `@/lib/github/user-access-token`.

### Roles

Two roles are seeded out of the box:

| Role    | Grants                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------ |
| `USER`  | Default. Access to the dashboard, findings, policies, audit pages, and the finding explanation stream. |
| `ADMIN` | Everything `USER` has, plus the `/api/admin/export` route and the `/admin` UI.                         |

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

| Route                               | Limit               | Window |
| ----------------------------------- | ------------------- | ------ |
| `POST /api/auth/*`                  | 10                  | 60s    |
| `POST /api/webhooks/github`         | 50                  | 60s    |
| `POST /api/sbom/scan`               | 20 (IP) / 10 (User) | 60s    |
| `GET /api/sbom/scan/status/[jobId]` | 120                 | 60s    |

All other routes have no explicit rate limit (Next.js / Vercel platform limits still apply).

---

## Error Handling

Routes wrapped in `withErrorHandler` (`src/lib/middleware/error-handler.ts`) return a consistent error envelope:

```ts
interface ApiError {
  success: false;
  error: string; // machine-readable code, e.g. "UNAUTHORIZED", "DATABASE_ERROR"
  message: string; // human-readable, with sensitive data scrubbed
}
```

### Error code mapping

| HTTP Status | `error`                 | When                                                                 |
| ----------- | ----------------------- | -------------------------------------------------------------------- |
| 400         | `BAD_REQUEST`           | Malformed input / failed Zod validation.                             |
| 401         | `UNAUTHORIZED`          | Missing or invalid session.                                          |
| 403         | `FORBIDDEN`             | Authenticated but lacking role.                                      |
| 404         | `NOT_FOUND`             | Resource doesn't exist or isn't owned by the caller.                 |
| 409         | `CONFLICT`              | Duplicate resource.                                                  |
| 422         | `UNPROCESSABLE_ENTITY`  | Semantic validation failure.                                         |
| 429         | `TOO_MANY_REQUESTS`     | Rate limit exceeded (see above).                                     |
| 500         | `INTERNAL_SERVER_ERROR` | Unexpected server failure. Sensitive paths/credentials are scrubbed. |
| 500         | `DATABASE_ERROR`        | Prisma/Postgres failure. Schema details redacted.                    |

**Sensitive-data scrubbing**: error messages are passed through `scrubSensitiveData()` before being returned to the client. This redacts connection strings, file paths, and `*=*` env-var patterns. The original (unredacted) error is logged server-side via the structured `logger`.

---

## Routes

### 1. Auth — `/api/auth/*`

**File**: `src/app/api/auth/[...nextauth]/route.ts`
**Handler**: NextAuth.js v5 `handlers` (re-exported).

This is the catch-all NextAuth route. It handles the OAuth dance with GitHub, JWT issuance/refresh, and session retrieval. You generally don't call it directly — the `<LoginButton>` component and NextAuth client hooks do.

| Method | Path                        | Purpose                                                                                                     |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/auth/signin`          | Renders the GitHub sign-in flow (redirects to `/login` per `auth.config.ts`).                               |
| `POST` | `/api/auth/callback/github` | OAuth callback from GitHub. Creates the user + `USER` role on first login, assigns a random heist codename. |
| `GET`  | `/api/auth/session`         | Returns the current session JSON (or `null` if signed out).                                                 |
| `POST` | `/api/auth/signout`         | Destroys the session.                                                                                       |

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

_(Plain text, not JSON — this route predates the standardized error envelope.)_

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

| `X-GitHub-Event`            | `action`                            | Behavior                                                                                                |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pull_request`              | `opened`, `synchronize`, `reopened` | Full scan pipeline (below).                                                                             |
| `pull_request`              | `closed`                            | Records merge/closure state for leaderboard scoring. No scan.                                           |
| `installation`              | `created`                           | Links the installer's GitHub account (via `sender.id`) and bulk-inserts selected repos in chunks of 50. |
| `installation_repositories` | `added`                             | Inserts newly-added repos for an existing installation.                                                 |
| _(anything else)_           | —                                   | Returns `200 { "message": "Event not tracked" }`.                                                       |

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
4. Reads `.secureflowignore` from the repo root **of the pull request's base branch** (if present) for custom ignore
   patterns. It is deliberately not read from the pull request's own branch: the file decides which files are
   skipped, so a change under review must not be able to switch off its own scan. Edits to `.secureflowignore`
   take effect for pull requests opened after they are merged.
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

### 3b. Single Finding Operations — `/api/findings/[id]`

**File**: `src/app/api/findings/[id]/route.ts`

REST endpoints for fetching, updating, and deleting a single security finding. All operations scope strictly to the session user via the relation chain: `Finding → ScanResult → PullRequest → Repository → userId`. A finding the caller does not own returns 404 to prevent IDOR enumeration. (#1465)

#### `GET /api/findings/[id]`

Returns full details for a single finding, including scan result, pull request metadata, and remediation patch status.

```http
GET /api/findings/cld1a2b3...
Cookie: next-auth.session-token=<jwt>
```

**Auth**: Session required (owner only)  
**Rate limit**: 120 req/min per IP (`STANDARD` tier)

**Response `200 OK`**:
```json
{
  "id": "cld1a2b3...",
  "type": "VULNERABILITY",
  "severity": "HIGH",
  "fileLocation": "src/lib/auth.ts:42",
  "lineStart": 42,
  "lineEnd": 45,
  "codeSnippet": "eval(userInput)",
  "explanation": "Remote code execution via eval",
  "remediation": "Remove eval usage",
  "promptInjectionSuspected": false,
  "fingerprint": "fp-abc123",
  "complianceTags": ["SOC2"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "remediationPatch": null,
  "scanResult": {
    "id": "scan-1",
    "riskScore": 80,
    "policyDecision": "BLOCK",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "pullRequest": {
      "id": "pr-1",
      "prNumber": 42,
      "title": "Feature branch",
      "state": "OPEN",
      "repositoryId": "repo-1"
    }
  }
}
```

#### `PATCH /api/findings/[id]`

Updates the triage status and/or severity of a finding. At least one field is required. Writes an immutable audit log entry.

```http
PATCH /api/findings/cld1a2b3...
Cookie: next-auth.session-token=<jwt>
Content-Type: application/json

{
  "triageStatus": "RESOLVED",
  "severity": "LOW",
  "note": "Verified safe input validation in test"
}
```

**Auth**: Session required (owner only)  
**Rate limit**: 120 req/min per IP, per-user inner guard  
**Valid `triageStatus`**: `OPEN`, `RESOLVED`, `FALSE_POSITIVE`, `IGNORED`  
**Valid `severity`**: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`

**Response `200 OK`**: Updated finding JSON object  
**Response `400 Bad Request`**: Validation failure or no updates provided  
**Response `404 Not Found`**: Finding does not exist or caller does not own it  
**Response `429 Too Many Requests`**: Rate limit exceeded

#### `DELETE /api/findings/[id]`

Permanently deletes a finding. Writes an audit log entry.

```http
DELETE /api/findings/cld1a2b3...
Cookie: next-auth.session-token=<jwt>
```

**Auth**: Session required (owner only)  
**Rate limit**: 30 req/min per IP (`ADMIN` tier), per-user inner guard

**Response `204 No Content`**: Successfully deleted  
**Response `404 Not Found`**: Finding not found or caller does not own it

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

| Name | Type   | Description                         |
| ---- | ------ | ----------------------------------- |
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
    if (json.type === "done") finalize(json.result);
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

| Name            | Type   | Required | Default              | Description                                                       |
| --------------- | ------ | -------- | -------------------- | ----------------------------------------------------------------- |
| `project`       | string | no       | `Classified Target`  | Target repository name shown on the card.                         |
| `score`         | number | no       | —                    | Security score (0–100). Drives the tier if `rank` is absent.      |
| `rank`          | string | no       | derived from `score` | One of `S`, `A`, `B`, `C`, `D`. Overrides the score-derived tier. |
| `findingsCount` | number | no       | —                    | Number of findings to display.                                    |

#### Tier resolution

If `rank` is provided and valid, it's used directly. Otherwise, `score` is mapped:

| Score range | Tier | Color                 | Quote                                    |
| ----------- | ---- | --------------------- | ---------------------------------------- |
| 90–100      | S    | `#facc15` (gold)      | Ghost protocol. Zero traces left behind. |
| 75–89       | A    | `#ef4444` (red)       | The vault is empty. Clean getaway.       |
| 60–74       | B    | `#fb923c` (orange)    | Job done. A few loose ends remain.       |
| 40–59       | C    | `#a3a3a3` (grey)      | Amateur hour. The vault noticed.         |
| 0–39        | D    | `#71717a` (dark grey) | Blown cover. Back to the drawing board.  |

#### Responses

**200 OK** — PNG image.

```http
Content-Type: image/png
Cache-Control: public, max-age=31536000, immutable
```

_(Standard `next/og` caching headers — the image is deterministic for a given query string.)_

**500 Internal Server Error** — image generation failure:

```
Failed to generate image
```

_(Plain text, not JSON.)_

---

### 6. Asynchronous SBOM Scan — `/api/sbom/scan`

**File**: `src/app/api/sbom/scan/route.ts`

Enqueues an asynchronous Software Bill of Materials (SBOM) dependency vulnerability scan. Accepts manifest file contents (`package.json`, `requirements.txt`, `bom.json`, `sbom.json`, or CycloneDX/SPDX JSON files) and delegates dependency parsing and vulnerability matching (via the OSV database) to a background BullMQ queue (`sbom-scans`).

Returns immediately with HTTP `202 Accepted` and a polling handle.

#### Request

```http
POST /api/sbom/scan
Content-Type: application/json
Content-Length: 142
Cookie: next-auth.session-token=<jwt>

{
  "fileName": "package.json",
  "content": "{\n  \"dependencies\": {\n    \"lodash\": \"4.17.19\"\n  }\n}",
  "repositoryId": "cld1a2b3c4d5e6f7g8h9i0j1"
}
```

**Auth**: Requires an authenticated session via NextAuth.js. If an optional `repositoryId` is provided, the authenticated user must own the repository.
**Rate limit**: `TIERS.SCAN` (20 req / 60s per IP) and inner user guard `TIERS.SCAN_USER` (10 req / 60s per user).
**Payload caps**: Request body capped at `1,114,112` bytes (1 MB manifest + 64 KB JSON envelope). `content` string capped at `1,048,576` bytes (1 MB).
**Supported manifest file names**:

- `package.json` (npm ecosystem)
- `requirements.txt` (PyPI ecosystem)
- `bom.json` / `sbom.json` (CycloneDX / SPDX SBOM JSON formats)
- Files with `.cdx.json` or `.spdx.json` suffixes

#### Request body schema

```ts
interface SbomScanRequestBody {
  fileName: string; // Required. Must be a supported manifest. Path traversal ('..' or leading '/') is blocked.
  content: string; // Required. Manifest content as raw text (max 1 MB).
  repositoryId?: string; // Optional. CUID of a repository owned by the session user.
}
```

#### Responses

**202 Accepted** — Scan job enqueued successfully:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Cache-Control: no-store

{
  "status": "queued",
  "jobId": "sbom-cld9876543210zyxwvutsrqp",
  "scanJobId": "cld9876543210zyxwvutsrqp",
  "message": "SBOM scan job enqueued successfully",
  "pollingUrl": "/api/sbom/scan/status/cld9876543210zyxwvutsrqp"
}
```

**400 Bad Request** — Missing required fields, path traversal in `fileName`, or unsupported manifest:

```json
{
  "error": "BAD_REQUEST",
  "message": "fileName must be a supported manifest (package.json, requirements.txt, bom.json, sbom.json)"
}
```

**401 Unauthorized** — Missing or invalid session:

```json
{
  "error": "UNAUTHORIZED",
  "message": "Unauthorized"
}
```

**404 Not Found** — Caller-supplied `repositoryId` does not exist or is not owned by the session user:

```json
{
  "error": "NOT_FOUND",
  "message": "Repository not found"
}
```

**413 Payload Too Large** — Payload exceeds maximum allowable size:

```json
{
  "error": "PAYLOAD_TOO_LARGE",
  "message": "Manifest file exceeds maximum allowed size of 1048576 bytes (1MB)"
}
```

**429 Too Many Requests** — Rate limit exceeded:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 35

{
  "error": "Too Many Requests",
  "message": "You have exceeded the rate limit. Please try again later."
}
```

---

### 7. SBOM Scan Status — `/api/sbom/scan/status/[jobId]`

**File**: `src/app/api/sbom/scan/status/[jobId]/route.ts`

Polls the progress and retrieves results for an asynchronous SBOM scan job previously enqueued via `POST /api/sbom/scan`.

#### Request

```http
GET /api/sbom/scan/status/cld9876543210zyxwvutsrqp
Cookie: next-auth.session-token=<jwt>
```

With pagination for large dependency manifests:

```http
GET /api/sbom/scan/status/cld9876543210zyxwvutsrqp?page=1&pageSize=50
Cookie: next-auth.session-token=<jwt>
```

**Auth**: Requires an authenticated session. The scan job must either belong to a repository owned by the user, or have an enqueuing audit entry initiated by the user. If unauthorized, returns `404 Not Found` (rather than 403) to prevent scan existence enumeration.
**Rate limit**: `TIERS.STANDARD` (120 req / 60s).
**Runtime**: `force-dynamic`.

#### Path parameters

| Name    | Type   | Description                                       |
| ------- | ------ | ------------------------------------------------- |
| `jobId` | string | The `scanJobId` returned when enqueuing the scan. |

#### Query parameters

| Name       | Type   | Required | Default | Description                                         |
| ---------- | ------ | -------- | ------- | --------------------------------------------------- |
| `page`     | number | no       | `1`     | Page number for paginated package listings (min 1). |
| `pageSize` | number | no       | `50`    | Items per page (min 1, max 100).                    |

#### Responses

**200 OK (Job in Progress — PENDING / PROCESSING)**:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store, no-cache, must-revalidate
Pragma: no-cache

{
  "scanJobId": "cld9876543210zyxwvutsrqp",
  "status": "PENDING",
  "totalFiles": 1,
  "scannedFiles": 0,
  "vulnerabilitiesFound": 0,
  "result": null,
  "error": null,
  "queuedAt": "2026-10-20T17:00:00.000Z",
  "startedAt": null,
  "completedAt": null
}
```

**200 OK (Job Completed with Vulnerabilities)**:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store, no-cache, must-revalidate

{
  "scanJobId": "cld9876543210zyxwvutsrqp",
  "status": "COMPLETED",
  "totalFiles": 1,
  "scannedFiles": 1,
  "vulnerabilitiesFound": 1,
  "result": {
    "scanId": "cld9876543210zyxwvutsrqp",
    "timestamp": "2026-10-20T17:00:04.123Z",
    "totalDependencies": 1,
    "vulnerabilities": [
      {
        "dependency": {
          "name": "lodash",
          "version": "4.17.19",
          "manifestFile": "package.json",
          "ecosystem": "npm"
        },
        "cveId": "CVE-2020-8203",
        "severity": "HIGH",
        "description": "Prototype pollution in lodash",
        "patchedVersion": "4.17.21"
      }
    ],
    "status": "VULNERABLE"
  },
  "error": null,
  "queuedAt": "2026-10-20T17:00:00.000Z",
  "startedAt": "2026-10-20T17:00:01.000Z",
  "completedAt": "2026-10-20T17:00:04.123Z"
}
```

**200 OK (Job Completed with Pagination Metadata)**:

When `page` or `pageSize` is requested and packages exist in the scan result:

```json
{
  "scanJobId": "cld9876543210zyxwvutsrqp",
  "status": "COMPLETED",
  "totalFiles": 1,
  "scannedFiles": 1,
  "vulnerabilitiesFound": 0,
  "result": {
    "scanId": "cld9876543210zyxwvutsrqp",
    "timestamp": "2026-10-20T17:00:04.123Z",
    "totalDependencies": 25,
    "packages": [
      {
        "name": "react",
        "version": "18.3.1",
        "manifestFile": "package.json",
        "ecosystem": "npm"
      }
    ],
    "vulnerabilities": [],
    "status": "CLEAN"
  },
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "totalPackages": 25,
    "totalPages": 1
  },
  "error": null,
  "queuedAt": "2026-10-20T17:00:00.000Z",
  "startedAt": "2026-10-20T17:00:01.000Z",
  "completedAt": "2026-10-20T17:00:04.123Z"
}
```

**400 Bad Request** — Missing or invalid `jobId`.

**401 Unauthorized** — Missing session.

**404 Not Found** — Scan job does not exist, or caller does not have authorization to view it.

---

### 8. Real-Time Voice Alerts Stream — `/api/voice-alerts/stream`

**File**: `src/app/api/voice-alerts/stream/route.ts`

Authenticated Server-Sent Events (SSE) endpoint providing real-time voice alerts (#1307). As background workers complete Pull Request scans that result in `BLOCK` decisions or `CRITICAL`/`HIGH` findings, events are published over user-isolated Redis channels (`voice-alert:${userId}`) and streamed directly to the connected browser session.

#### Request

```http
GET /api/voice-alerts/stream
Cookie: next-auth.session-token=<jwt>
Accept: text/event-stream
```

**Auth**: Requires an authenticated session via NextAuth.js (`401 Unauthorized` if not signed in).
**Opt-In Check**: Verifies `user.voiceAlertsEnabled` in PostgreSQL. If disabled or false, the server returns `204 No Content` immediately, informing the client not to establish an open stream or retry connections.
**Tenant Isolation**: Redis Pub/Sub subscription is keyed strictly by `userId` (`voice-alert:${userId}`), ensuring alerts never leak across accounts.
**Runtime**: `force-dynamic`.

#### Responses

**204 No Content** — User has not enabled voice alerts in account settings:

```http
HTTP/1.1 204 No Content
```

**200 OK** — Live Server-Sent Events stream:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

#### SSE Stream Frames

Stream frames use standard `data: <json>\n\n` formatting.

1. **Connection Heartbeat Frame** (emitted immediately on connection open):

```json
{ "type": "connected" }
```

2. **Voice Alert Event Frame**:

```json
{
  "type": "voice-alert",
  "repositoryFullName": "octocat/defense-api",
  "prNumber": 42,
  "decision": "BLOCK",
  "topSeverity": "CRITICAL",
  "alertId": "cld-delivery-uuid-98765"
}
```

| Field                | Type                   | Description                                                                                                                |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `"voice-alert"`        | Event type identifier.                                                                                                     |
| `repositoryFullName` | `string`               | Repository full name (`"owner/repo"`) as reported by GitHub.                                                               |
| `prNumber`           | `number`               | Pull request number triggering the scan.                                                                                   |
| `decision`           | `"BLOCK" \| "REVIEW"`  | Policy decision causing the alert.                                                                                         |
| `topSeverity`        | `"CRITICAL" \| "HIGH"` | Highest finding severity detected in the scan.                                                                             |
| `alertId`            | `string`               | Unique deduplication key (webhook delivery ID) ensuring background worker retries do not trigger duplicate audio playback. |

#### Client Consumption Example

```ts
const eventSource = new EventSource("/api/voice-alerts/stream", {
  withCredentials: true,
});

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "connected") {
    console.log("Connected to voice alerts real-time stream");
  } else if (data.type === "voice-alert") {
    console.log(`Voice alert for ${data.repositoryFullName} PR #${data.prNumber}:`, data);
    const audioUrl = `/api/voice-alerts/audio?repo=${encodeURIComponent(data.repositoryFullName)}&decision=${data.decision}&severity=${data.topSeverity}`;
    const audio = new Audio(audioUrl);
    audio.play().catch(console.warn);
  }
};

eventSource.onerror = (err) => {
  console.warn("Voice alert stream disconnected:", err);
};
```

---

## Type Reference

These are the persisted data shapes referenced throughout the routes above. All are defined in `prisma/schema.prisma`.

### `Repository`

```ts
{
  id: string; // CUID
  githubId: bigint; // GitHub repo ID
  fullName: string; // "owner/name"
  owner: string;
  isActive: boolean;
  userId: string; // SecureFlow owner
}
```

### `PullRequest`

```ts
{
  id: string; // CUID
  githubId: bigint;
  prNumber: number;
  title: string;
  state: string; // "open" | "closed" | "merged"
  status: string; // "PASS" | "REVIEW_REQUIRED" | "BLOCKED"
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
  policyDecision: string; // "PASS" | "REVIEW_REQUIRED" | "BLOCKED"
  createdAt: string; // ISO timestamp
}
```

### `Finding`

```ts
{
  id: string;
  scanResultId: string;
  type: string; // "Secret" | "Vulnerability" | "Misconfig" | ...
  severity: string; // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  fileLocation: string;
  codeSnippet: string | null;
  explanation: string | null;
  remediation: string | null;
  promptInjectionSuspected: boolean;
  createdAt: string; // ISO timestamp
}
```

### `AuditLog`

```ts
{
  id: string;
  userId: string | null;
  action: string; // "Scan Triggered" | "Policy Evaluation" | ...
  resource: string; // "owner/repo#42"
  decision: string | null; // "PASS" | "REVIEW_REQUIRED" | "BLOCKED" | "FAIL"
  metadata: object | null; // arbitrary JSON
  timestamp: string; // ISO timestamp
}
```

### `ScanJob`

```ts
{
  id: string; // CUID
  repositoryId: string | null;
  pullRequestId: string | null;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  totalFiles: number;
  scannedFiles: number;
  vulnerabilitiesFound: number;
  error: string | null;
  queuedAt: string; // ISO timestamp
  startedAt: string | null;
  completedAt: string | null;
}
```

### `SbomScanResult`

```ts
{
  scanId: string;
  timestamp: string; // ISO timestamp
  totalDependencies: number;
  vulnerabilities: VulnerabilityMatch[];
  status: "CLEAN" | "WARNING" | "VULNERABLE" | "ERROR";
}
```

### `VulnerabilityMatch` & `Dependency`

```ts
interface Dependency {
  name: string;
  version: string;
  manifestFile: string;
  ecosystem: "npm" | "pypi" | "maven" | "gem";
}

interface VulnerabilityMatch {
  dependency: Dependency;
  cveId: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
  patchedVersion: string | null;
}
```

### `VoiceAlertEvent`

```ts
{
  repositoryFullName: string;
  prNumber: number;
  decision: "BLOCK" | "REVIEW";
  topSeverity: "CRITICAL" | "HIGH";
  alertId: string;
}
```

### `WebhookEvent`

```ts
{
  id: string;
  deliveryId: string; // X-GitHub-Delivery UUID, unique
  repositoryId: string | null;
  pullRequestId: string | null;
  createdAt: string;
}
```

---

## Environment Variables

Required across the API surface:

| Variable                   | Used by                   | Purpose                                                 |
| -------------------------- | ------------------------- | ------------------------------------------------------- |
| `GITHUB_CLIENT_ID`         | `/api/auth/*`             | GitHub OAuth client ID.                                 |
| `GITHUB_CLIENT_SECRET`     | `/api/auth/*`             | GitHub OAuth client secret.                             |
| `GITHUB_APP_ID`            | `/api/webhooks/github`    | SecureFlow GitHub App ID.                               |
| `GITHUB_PRIVATE_KEY`       | `/api/webhooks/github`    | App PEM private key (`\n`-escaped).                     |
| `GITHUB_WEBHOOK_SECRET`    | `/api/webhooks/github`    | HMAC secret for webhook signature verification.         |
| `WEBHOOK_MAX_BYTES`        | Generic webhook routes    | (Optional) Body cap in bytes; default 1 MiB.            |
| `NEXT_PUBLIC_APP_URL`      | `/share/heist` (OG meta)  | Public origin for absolute OG image URLs.               |
| `DATABASE_URL`             | All DB-backed routes      | Postgres connection string.                             |
| `UPSTASH_REDIS_REST_URL`   | `withRateLimit`           | (Optional) Upstash Redis for distributed rate limiting. |
| `UPSTASH_REDIS_REST_TOKEN` | `withRateLimit`           | (Optional) Upstash Redis token.                         |
| `LOCAL_AI_URL`             | `/src/ai/local-model.ts`  | (Optional) Local OpenAI-compatible inference URL.       |
| `LOCAL_AI_MODEL`           | `/src/ai/local-model.ts`  | (Optional) Model tag for local inference.               |
| `LOCAL_AI_FALLBACK_MODELS` | `/src/ai/local-model.ts`  | (Optional) Comma-separated fallback models for OOM.     |
| `ELEVENLABS_API_KEY`       | `/api/voice-alerts/audio` | (Optional) ElevenLabs API key for synthesized voice.    |

The generic webhook routes refuse a legacy `sha256=` signature computed over the
bare body, because it signs no timestamp and can be replayed indefinitely. Send a
v1 signature (`t=<unix>,v1=<hex>`) or a legacy digest over `<unix>.<body>`. For
senders that cannot change yet, `WEBHOOK_ALLOW_UNBOUND_LEGACY_SIGNATURES=true`
accepts the bare-body form again. While it is enabled, every request admitted
this way logs a `[WEBHOOK_DEPRECATION]` warning (no payload, secret or signature),
so you can find senders that still need to move to v1. The opt-in is deprecated
and may be removed in a future release.

---

## Changelog

| Date       | Change                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-01-31 | Initial API documentation covering all 5 route groups.                                                                                             |
| 2026-10-20 | Documented asynchronous SBOM scan API (/api/sbom/scan, /api/sbom/scan/status/[jobId]) and real-time voice alert stream (/api/voice-alerts/stream). |

---
