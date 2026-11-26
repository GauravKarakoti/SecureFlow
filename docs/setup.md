# Local Development Setup Guide

This guide walks you through acquiring every credential required to run SecureFlow locally, and maps out the secrets/environment matrix for running specialized CI workflows offline (see [Section 9](#9-specialized-ci-workflows--environment-secrets--local-offline-matrix)).

---

## 1. PostgreSQL / Prisma (`DATABASE_URL`, `DATABASE_POOL_URL`, `DB_POOL_MAX`)

**Option A — Local PostgreSQL**

1. Install [PostgreSQL](https://www.postgresql.org/download/).
2. Create a database:
   ```sql
   CREATE DATABASE secureflow;
   ```
3. Set in `.env`:
   ```env
   DATABASE_URL="postgresql://postgres:<your_password>@localhost:5432/secureflow"
   DATABASE_POOL_URL="postgresql://postgres:<your_password>@localhost:5432/secureflow"   # same as DATABASE_URL for local dev
   DB_POOL_MAX=10
   ```

**Option B — Neon (recommended for cloud/serverless)**

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. From the **Connection Details** panel, copy:
   - **Direct URL** → `DATABASE_URL`
   - **Pooled URL** → `DATABASE_POOL_URL`
3. Set `DB_POOL_MAX=10` (or adjust based on your plan's connection limit).

After setting the URLs, run:

```bash
npm run db:gen
npm run db:migrate
npm run db:seed
```

---

## 2. Groq SDK (`GROQ_API_KEY`, `AI_MODEL`)

1. Sign up at [console.groq.com](https://console.groq.com).
2. Go to **API Keys → Create API Key**.
3. Copy the key → `GROQ_API_KEY`.
4. `AI_MODEL` defaults to `openai/gpt-oss-20b`. Change only if you want a different supported model (Groq's [deprecation page](https://console.groq.com/docs/deprecations) lists the ones that have been shut down).

```env
GROQ_API_KEY="gsk_..."
AI_MODEL="openai/gpt-oss-20b"
```

---

## 3. GitHub App (`GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_APP_URL`)

1. Go to **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **Homepage URL**: `http://localhost:9002`
   - **Webhook URL**: your ngrok URL + `/api/webhooks/github`
     ```bash
     ngrok http 9002   # copy the https:// forwarding URL
     ```
   - **Webhook Secret**: any random string (e.g. `openssl rand -hex 20`) → `GITHUB_WEBHOOK_SECRET`
3. Set **Repository Permissions**: Contents `Read`, Pull Requests `Read & Write`, Checks `Read & Write`, Code scanning alerts `Read & Write`.
   - Code scanning alerts (the `security_events` permission) is what lets SecureFlow publish findings to the repository's **Security → Code scanning** tab via the GitHub SARIF upload API. Without it the scan still runs and still posts its check run; only the upload is skipped.
   - **Opt-in per repository**: Enable this in the dashboard under **Settings (`/dashboard/settings`) → Publish findings to GitHub Code Scanning**.
   - **Permission & failure handling**: Without `security_events: write` (or if Advanced Security is disabled on a private repository, returning 403 or 404), the scan still completes and posts its check run without failing; SecureFlow logs the response and displays an actionable warning banner on the repository card in Settings.
   - **Secret Masking & Zero Leakage**: All finding messages and remediation summaries uploaded via SARIF are scrubbed with `maskFindingText`. Detected API keys and secrets are strictly redacted with `[REDACTED_BY_THE_PROFESSOR]` prior to upload.
   - **Deduplication**: Findings include deterministic rule IDs and stable partial fingerprints (`secureflow/finding/v1`), ensuring re-scans update existing alerts on GitHub without duplication.
   - GitHub accepts these uploads for public repositories, and for private repositories only with GitHub Advanced Security enabled. A private repository without it answers `403`, which SecureFlow records as a dashboard warning and moves past.
4. Subscribe to events: `Pull request`, `Merge group`, `Installation`, `Installation repositories`, `Check run`, `Check suite`.
   - Subscribing to `Check run` and `Check suite` (action `rerequested`) allows developers to trigger a new security scan and update the existing check directly from the GitHub PR "Re-run" button without pushing empty commits.
5. Click **Create GitHub App**, then:
   - Copy **App ID** → `GITHUB_APP_ID`
   - Scroll to **Private Keys → Generate a private key** → download `.pem` → paste its full contents (including headers) into `GITHUB_PRIVATE_KEY`, replacing newlines with `\n`:
     ```bash
     awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-app.pem
     ```
   - Copy the app's public URL → `GITHUB_APP_URL` (e.g. `https://github.com/apps/your-app-name`)

```env
GITHUB_APP_ID="123456"
GITHUB_WEBHOOK_SECRET="your_random_secret"
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_URL="https://github.com/apps/your-app-name"
```

### GitHub Merge Queue Support

Repositories utilizing GitHub's **Merge Queue** feature run required checks on temporary merge groups (`gh-readonly-queue/...`).

To enable SecureFlow checks on merge queues:

1. **GitHub App Permissions & Events**:
   - Permissions: `Checks: Read & Write`, `Contents: Read`, `Pull Requests: Read & Write`
   - Event Subscriptions: Ensure **`Merge group`** (`merge_group`) is checked in GitHub App Settings -> Subscribe to events.
2. **Required Status Check**:
   - In repository **Settings -> Branches -> Branch protection rules** (or Rulesets), add **`SecureFlow Scan`** under **Require status checks to pass before merging** and include it in your Merge Queue required checks.
3. **Execution Behavior**:
   - When a PR enters the merge queue, GitHub dispatches `merge_group` with action `checks_requested`.
   - SecureFlow compares the merged diff against the PR's diff. If the diff content is unchanged, it reuses the previous PR scan result and gate decision immediately without making redundant LLM calls.
   - If changes from the base branch produce a new combined diff, SecureFlow performs a fast scan of the combined diff against the base branch policy gate.
   - A completed check run named `SecureFlow Scan` is reported on the merge group head SHA so the queue never hangs.

### GitHub Enterprise Server (GHES)

Organizations hosting their own GitHub Enterprise Server instance can point SecureFlow at it using two environment variables:

- `GITHUB_API_URL`: The REST API base URL for your GHES instance (e.g. `https://ghe.mycorp.com/api/v3`). Defaults to `https://api.github.com`.
- `GITHUB_WEB_URL`: The web URL for your GHES instance (e.g. `https://ghe.mycorp.com`). If omitted, it automatically infers the origin from `GITHUB_API_URL` when pointing to a custom instance, or defaults to `https://github.com`.

```env
GITHUB_API_URL="https://ghe.mycorp.com/api/v3"
GITHUB_WEB_URL="https://ghe.mycorp.com"
```

> **Security Note:** In production mode (`NODE_ENV=production`), non-HTTPS URLs are rejected at startup to protect installation tokens and repository data.

### Outbound Webhooks (SIEM, Ticketing, Chatbots)

SecureFlow supports registering HTTPS outbound webhooks to receive real-time JSON event notifications:

- **Supported Events**:
  - `scan.completed`: Fired whenever a pull request scan finishes.
  - `scan.blocked`: Fired when a scan fails policy (critical findings).
  - `finding.created`: Fired when new security findings are detected.
  - `finding.dismissed`: Fired when a finding is triaged as dismissed or false positive.
- **HMAC Signature**: Each request carries `X-SecureFlow-Signature` (HMAC-SHA256 computed using a per-endpoint secret shown once at creation).
- **Replay Protection**: Includes `X-SecureFlow-Event-Id` and `X-SecureFlow-Timestamp`.
- **SSRF Hardening**: Rejects loopback, link-local, carrier-grade NAT, private IP ranges (RFC 1918), and internal TLDs both upon registration and before dispatch.
- **Zero-Leakage Guarantee**: Payloads contain strictly metadata (repository, PR number, commit SHA, decision, finding type, severity, file location). Raw code snippets, diffs, and secret values are never included.
- **Fault-Tolerant Delivery**: Asynchronous delivery with a 5-second timeout, retries with exponential backoff (up to 3 attempts), and a delivery log in Settings.

---

## 4. GitHub OAuth / NextAuth (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_URL`)

These power the **Sign in with GitHub** button via NextAuth.js.

1. In the same GitHub App you created above, scroll to **OAuth Credentials**.
2. Copy **Client ID** → `GITHUB_CLIENT_ID`.
3. Click **Generate a new client secret** → `GITHUB_CLIENT_SECRET`.
4. Generate `AUTH_SECRET`:
   ```bash
   openssl rand -base64 32
   ```
5. Set `AUTH_URL` to your local dev URL:
   ```env
   AUTH_URL="http://localhost:9002"
   ```

```env
GITHUB_CLIENT_ID="Iv1.abc123"
GITHUB_CLIENT_SECRET="your_client_secret"
AUTH_SECRET="your_generated_secret"
AUTH_URL="http://localhost:9002"
```

---

## 5. Redis (`REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)

Redis is optional for local development. Leave all three blank if you don't need caching/rate-limiting locally.

**For production or if your feature branch requires it:**

1. Sign up at [upstash.com](https://upstash.com) and create a Redis database.
2. From the database dashboard, copy:
   - **Redis URL** (starts with `rediss://`) → `REDIS_URL`
   - **REST URL** → `UPSTASH_REDIS_REST_URL`
   - **REST Token** → `UPSTASH_REDIS_REST_TOKEN`

```env
REDIS_URL="rediss://default:<token>@<host>:6379"
UPSTASH_REDIS_REST_URL="https://<host>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your_token"
```

---

## 6. ArmorIQ (optional — `ARMORIQ_API_KEY`, `USER_ID`, `AGENT_ID`)

These are only needed for advanced policy features. Leave blank for standard local development.

If ArmorIQ becomes slow or unreachable, a circuit breaker opens after 3 consecutive upstream failures (timeouts, rate limits, 5xx, network errors) and ArmorIQ-gated actions are refused until it answers a probe. Both knobs are optional:

- `ARMORIQ_CIRCUIT_FAILURE_THRESHOLD` — consecutive failures before the circuit opens (default `3`).
- `ARMORIQ_CIRCUIT_RESET_TIMEOUT_MS` — milliseconds before a probe is allowed (default `30000`).

---

## 7. Workspace Architecture & Dependency Management

SecureFlow is organized as an **npm workspace** monorepo with the root project and the `cli/` workspace (`secureflow-cli`). All dependencies are hoisted and managed under a single source of truth at `package-lock.json` in the project root.

### Common Workspace Commands

- **Install all dependencies across root and workspaces**:
  ```bash
  npm install
  ```
- **Build CLI package via workspace**:
  ```bash
  npm run cli:build
  # or directly with npm workspace:
  npm run build --workspace=cli
  ```
- **Run CLI tests via workspace**:
  ```bash
  npm run cli:test
  # or directly with npm workspace:
  npm run test --workspace=cli
  ```
- **Typecheck CLI workspace**:
  ```bash
  npm run cli:typecheck
  ```

---

## 8. Verifying Your Setup via Dashboard Checklist

Once SecureFlow is running, sign in to the dashboard at `http://localhost:9002/dashboard`. The **"Get Started with SecureFlow"** onboarding checklist guides you through verifying:

1. **GitHub App installed**: Verifies GitHub App connection to your user account.
2. **At least one repository connected**: Ensures repository sync has occurred.
3. **Webhook delivery received**: Click **"Send Test Event"** to simulate and verify an HMAC-SHA256 signed GitHub ping delivery without scanning real code.
4. **At least one policy enabled**: Confirms guardrails under `/dashboard/policies`.
5. **First scan completed**: Verifies that opening or updating a PR executes the scan pipeline.

For performance benchmarking and burst webhook ingestion testing against your local Docker Compose environment, see the **[Webhook Load Testing Guide](./load-testing.md)**.

The checklist is dismissible and automatically hides once all 5 setup steps are completed.

---

## 9. Specialized CI Workflows — Environment, Secrets & Local Offline Matrix

While `npm test` ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs core unit tests, lint, typecheck, and schema checks, four specialized workflows cover adversarial AI evaluation, browser E2E flows, webhook load testing, and static SAST analysis. **None of these four workflows require live third-party API credentials to run locally.**

### Workflow Secrets & Environment Summary

| Workflow                                                              | Triggers                                                                | Custom GitHub Secrets Expected                      | Key Env Vars / Placeholders Used                                                                                                                 | Hits Live External Endpoints?                                                  |
| :-------------------------------------------------------------------- | :---------------------------------------------------------------------- | :-------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| [`ai-eval.yml`](../.github/workflows/ai-eval.yml)                     | PR/push (`src/ai/**`), nightly (`03:00 UTC`), `workflow_dispatch`       | Optional `GROQ_API_KEY` (falls back to dummy key)   | `NODE_ENV=test`, `VITEST=true`, `GROQ_API_KEY=ci-dummy-key`                                                                                      | **No** — `vitest.setup.ts` & test mocks isolate LLM/DB/Redis                   |
| [`playwright.yml`](../.github/workflows/playwright.yml)               | Push/PR (`main`, `develop`), `workflow_dispatch`                        | None                                                | `CI=true`, `NEXT_PUBLIC_MOCK_DB=true`, `NEXT_PUBLIC_MOCK_AUTH=true`, `ALLOW_MOCK_AUTH=true`, plus placeholder DB/OAuth/App/Webhook/Auth values   | **No** — uses mock DB, mock session cookie, and mocked queue jobs              |
| [`webhook-load-test.yml`](../.github/workflows/webhook-load-test.yml) | Manual `workflow_dispatch` (`target_url`, `webhook_secret`, `duration`) | None (uses synthetic `webhook_secret` input)        | Generated `.env` with Compose Postgres/Redis URLs, `TRUSTED_PROXY_HOP_COUNT=1`, synthetic `GITHUB_WEBHOOK_SECRET`, and placeholder build secrets | **No** (default `localhost:9002` Compose stack); synthetic `loadtest-org` data |
| [`codeql.yml`](../.github/workflows/codeql.yml)                       | Push (`main`, `develop`), PR (`main`), weekly (`04:30 UTC Sun`)         | None (`GITHUB_TOKEN` with `security-events: write`) | Standard Node `22` build/SAST env (`security-extended,security-and-quality` queries)                                                             | GitHub SARIF upload & `npm audit` advisory lookup only in CI                   |

> **Live LLM Suites Note:** Unlike `ai-eval.yml` and `nightly-fuzzing.yml`, opt-in live model checks — `npm run test:prompts:live` (`scripts/test-prompts-live.ts`) and `.github/workflows/scanner-stability.yml` (`GROQ_STABILITY_API_KEY` or `GROQ_API_KEY`, guarded against fork PRs) — call live Groq endpoints when given a real `gsk_...` key (`test:prompts:live` auto-skips if `GROQ_API_KEY` is missing or a placeholder such as `test-key` or `dummy-key-for-build`).

---

### 9.1 AI Evaluation & Red-Team Suite (`.github/workflows/ai-eval.yml`)

- **What CI runs**: `npm run test:redteam` (`vitest run src/ai/flows/heist-prompt-guard.redteam.test.ts`). In `vitest.config.ts`, `**/*.redteam.test.ts` specs are excluded from standard `npm test` and enabled only when `npm_lifecycle_event === "test:redteam"` or `REDTEAM=true`.
- **Environment & Secrets**:
  - `NODE_ENV=test` and `VITEST=true` (skip `src/lib/env.ts` server boot validation).
  - `GROQ_API_KEY`: reads `secrets.GROQ_API_KEY` if configured, otherwise `'ci-dummy-key'` (safe on fork PRs without secrets).
  - Automatic test harness stubs in `vitest.setup.ts` set `ARMORIQ_PROOF_SIGNING_KEY` (`"test-armoriq-proof-signing-key"`) and mock `@/lib/prisma`, `groq-sdk`, `ioredis`, `next-auth`, `@/auth`, and `server-only`.
- **Run local offline subsets**:
  ```bash
  # Full red-team suite (completely offline)
  npm run test:redteam

  # Windows PowerShell or custom Vitest invocation with explicit dummy env
  npx cross-env REDTEAM=true GROQ_API_KEY=ci-dummy-key NODE_ENV=test VITEST=true vitest run src/ai/flows/heist-prompt-guard.redteam.test.ts

  # Filter to a specific describe/test subset (e.g. streaming guard regression)
  npm run test:redteam -- -t "Streaming Flows"

  # Run standard prompt-guard & AI resilience suites included in regular CI
  npm test -- src/ai/flows/heist-prompt-guard.test.ts src/ai/flows/security-helpers.test.ts tests/ai/streaming-prompt-guard-regression.test.ts
  ```

---

### 9.2 Playwright E2E Suite (`.github/workflows/playwright.yml`)

- **What CI runs**: `npx prisma generate` → `npx playwright install --with-deps` → `npm run build` → `npx playwright test e2e/` → `npm run test:e2e`. (`playwright.config.ts` matches `["e2e/**/*.spec.ts", "tests/e2e/**/*.spec.ts"]` across `chromium`, `Mobile Safari`, and `Pixel 5`, excluding `visual-regression.spec.ts` unless `--project=visual` is specified.)
- **Environment & Placeholder Matrix**:
  - **Offline isolation flags**: `NEXT_PUBLIC_MOCK_DB="true"`, `NEXT_PUBLIC_MOCK_AUTH="true"`, `ALLOW_MOCK_AUTH="true"` (dual client+server opt-in so `e2e/fixtures.ts` injects the `mock-session` cookie without GitHub OAuth), `AUTH_TRUST_HOST="true"`, `NEXTAUTH_TRUST_HOST="true"`, and `E2E_MOCK_QUEUE_JOB="true"` (set in `playwright.config.ts` `webServer.env` so webhook tests succeed without Redis/BullMQ).
  - **Build & runtime validation placeholders (`src/lib/env.ts`)**: `DATABASE_URL` & `DATABASE_POOL_URL` (`postgresql://ci:ci@localhost:5432/secureflow`), `GROQ_API_KEY` (`ci-build-placeholder`), `GITHUB_APP_ID` (`"1"`), `GITHUB_WEBHOOK_SECRET` (`e2e-webhook-secret`), `GITHUB_PRIVATE_KEY` (valid BEGIN/END PRIVATE KEY markers with dummy body), `GITHUB_CLIENT_ID` & `GITHUB_CLIENT_SECRET` (`ci-build-placeholder`), `AUTH_SECRET` & `NEXTAUTH_SECRET` (`e2e-test-secret-key`), `AUTH_URL`, `NEXTAUTH_URL`, & `NEXT_PUBLIC_APP_URL` (`http://localhost:9002`).
  - **Multi-provider webhook fixture secrets** (`playwright.config.ts` & `e2e/helpers/webhook-fixtures.ts`): `GITLAB_WEBHOOK_TOKEN="e2e-gitlab-token"`, `BITBUCKET_WEBHOOK_SECRET="e2e-bitbucket-secret"`, and `GENERIC_WEBHOOK_SECRET="e2e-generic-secret"`.
- **Run local offline subsets**:
  `playwright.config.ts` automatically injects all placeholder/mock variables into its `webServer` (`npm run dev` when `CI` is unset), so you do not need live Postgres, Redis, or GitHub credentials locally:
  ```bash
  # One-time setup (generate Prisma client & install Chromium)
  npm run db:gen
  npx playwright install chromium

  # Run a single spec offline in Chromium only (skips Mobile Safari & Pixel 5)
  npx playwright test e2e/auth.spec.ts --project=chromium

  # Run signed multi-provider webhook E2E specs without external webhooks/queues
  npx playwright test e2e/github-webhook.spec.ts e2e/gitlab-webhook.spec.ts e2e/bitbucket-webhook.spec.ts e2e/generic-webhook.spec.ts --project=chromium

  # Run specs from tests/e2e/
  npx playwright test tests/e2e/webhook-queue.spec.ts --project=chromium

  # Accessibility subset (Desktop Chrome)
  npm run test:a11y -- --project=chromium
  ```
  > If you run with `CI=true` locally (`npm run build && npm run start -- -p 9002`), export the placeholder variables listed in `.github/workflows/playwright.yml` (or put them in `.env`) before `npm run build` so `src/lib/env.ts` build-time validation passes.

---

### 9.3 Webhook Load Test (`.github/workflows/webhook-load-test.yml`)

- **What CI runs**: Manual `workflow_dispatch` job that spins up `docker compose up -d --build` (`db`, `migrate`, `redis`, `app` in `docker-compose.yml`) when `target_url` is `http://localhost*` or `http://127.0.0.1*`, executes `k6 run load-tests/webhook.k6.js`, and runs `docker compose down -v`.
- **Inputs & Generated `.env` Matrix**:
  - **Inputs**: `target_url` (default `http://localhost:9002`), `webhook_secret` (default `test-webhook-secret-load-testing-only`), `duration` (optional override; blank uses the 4 ramping stages in `load-tests/webhook.k6.js`).
  - **Generated `.env` (Compose mode)**: `DATABASE_URL` / `DATABASE_POOL_URL` (`postgresql://secureflow:secureflow@db:5432/secureflow`), `REDIS_URL` (`redis://redis:6379`), `GITHUB_WEBHOOK_SECRET` (must match `k6 -e GITHUB_WEBHOOK_SECRET`), `TRUSTED_PROXY_HOP_COUNT=1` (lets rotating `X-Forwarded-For` `192.30.252.x` headers in `webhook.k6.js` distribute across IP rate-limit buckets), plus synthetic `GROQ_API_KEY`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_URL`, and `NEXT_PUBLIC_APP_URL`.
  - **Isolation**: `load-tests/webhook.k6.js` uses synthetic repo `loadtest-org/sample-repo`, unique `X-GitHub-Delivery` UUIDs, and local HMAC-SHA256 `X-Hub-Signature-256` signatures — **never** point `target_url` at a production server or pass production secrets.
- **Run local offline subsets**:
  ```bash
  # Zero-container check: verify HMAC signature generation used by k6
  npm test -- tests/load-tests/signature.test.ts

  # Short local k6 smoke subset against Docker Compose (see docs/load-testing.md)
  docker compose up -d --build
  k6 run --vus 2 --duration 10s \
    -e TARGET_URL=http://localhost:9002 \
    -e GITHUB_WEBHOOK_SECRET=test-webhook-secret-load-testing-only \
    load-tests/webhook.k6.js
  docker compose down -v
  ```
  On Docker Desktop (macOS/Windows) using `npm run test:load:docker`, pass `-e TARGET_URL=http://host.docker.internal:9002`. See **[Webhook Load Testing Guide](./load-testing.md)** for full details.

---

### 9.4 CodeQL Static Analysis (`.github/workflows/codeql.yml`)

- **What CI runs**: `npm ci --legacy-peer-deps`, non-blocking `npm audit --audit-level=high --production`, and `github/codeql-action` (`init`, `autobuild`, `analyze`) for `javascript-typescript` with `security-extended,security-and-quality`.
- **Environment & Secrets**: Requires **no custom repository secrets**; uses GitHub Actions' default `GITHUB_TOKEN` with `actions: read`, `contents: read`, and `security-events: write` to upload SARIF results to GitHub Code Scanning.
- **Run local offline subsets**:
  ```bash
  # 1. Offline lint & TypeScript checks covering static quality/safety rules
  npm run lint && npm run typecheck

  # 2. Local CodeQL CLI scan (offline once the CodeQL JS/TS query pack is cached)
  codeql database create .codeql-db --language=javascript-typescript --overwrite
  codeql database analyze .codeql-db \
    codeql/javascript-queries:codeql-suites/javascript-security-extended.qls \
    --format=sarif-latest --output=codeql-results.sarif

  # 3. Mirror production dependency audit step (queries npm registry advisories)
  npm audit --audit-level=high --omit=dev
  ```

---

## Quick-start checklist

```
[ ] DATABASE_URL set and `npm run db:migrate` succeeded
[ ] GROQ_API_KEY set
[ ] GitHub App created — APP_ID, WEBHOOK_SECRET, PRIVATE_KEY, APP_URL set
[ ] GitHub OAuth credentials set — CLIENT_ID, CLIENT_SECRET
[ ] AUTH_SECRET generated and set
[ ] ngrok running and Webhook URL updated in GitHub App settings
[ ] npm install completed with single root package-lock.json
[ ] npm run dev starts without errors at http://localhost:9002
```
