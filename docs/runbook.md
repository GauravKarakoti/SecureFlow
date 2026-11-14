# SecureFlow Operations Runbook

This runbook provides operators with actionable troubleshooting steps for diagnosing and resolving scan outages, webhook failures, infrastructure bottlenecks, and misconfigurations in SecureFlow.

---

## 📋 Triage Matrix

| Issue Category          | Primary Symptoms                                                                   | Key Environment Variables                                                                        | Section                                                                                  |
| :---------------------- | :--------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| **Webhook Deliveries**  | PRs opened without scans triggering; 401/413/500 errors in GitHub App delivery log | `GITHUB_WEBHOOK_SECRET`<br>`GITHUB_WEBHOOK_MAX_BYTES`<br>`GITHUB_APP_ID`<br>`GITHUB_PRIVATE_KEY` | [1. Webhook Deliveries Failing](#1-webhook-deliveries-failing)                           |
| **Queues & Redis**      | PR checks stuck in pending; jobs pile up in `waiting`; `RedisConfigurationError`   | `REDIS_URL`<br>`UPSTASH_REDIS_REST_URL`<br>`UPSTASH_REDIS_REST_TOKEN`                            | [2. Queue Stuck or Redis Unavailable](#2-queue-stuck-or-redis-unavailable)               |
| **Groq / AI Scanner**   | Scans fail with 429 or timeout; model not found errors; PR check run failure       | `GROQ_API_KEY`<br>`GROQ_MODEL`<br>`LLM_CACHE_TTL_SECONDS`<br>`LOCAL_AI_URL`                      | [3. Groq Errors and Rate Limits](#3-groq-errors-and-rate-limits)                         |
| **Database Pooling**    | `too many clients already`; `ETIMEDOUT`; `role "nextjs" does not exist`            | `DATABASE_POOL_URL`<br>`DATABASE_URL`<br>`DB_POOL_MAX`                                           | [4. Database Pooling Errors](#4-database-pooling-errors)                                 |
| **Proxy Rate Limiting** | Legitimate users hit 429 ("Rate limit exceeded"); all users share one bucket       | `TRUSTED_PROXY_HOP_COUNT`<br>`TRUSTED_PROXY_IPS`                                                 | [5. Rate-Limit Buckets Wrong Behind a Proxy](#5-rate-limit-buckets-wrong-behind-a-proxy) |

---

## 1. Webhook Deliveries Failing

Inbound GitHub webhooks enter through `/api/webhooks/github`. Requests are validated in a strict sequence: payload size &rarr; delivery ID presence &rarr; HMAC-SHA256 signature verification &rarr; payload JSON parsing &rarr; BullMQ queue delegation.

### Relevant Environment Variables

- `GITHUB_WEBHOOK_SECRET` _(Required)_: The secret string configured in the GitHub App settings used to verify the HMAC-SHA256 signature in the `X-Hub-Signature-256` header.
- `GITHUB_WEBHOOK_SECRET_PREVIOUS` _(Optional)_: The previous webhook secret during rotation. Allows zero-downtime secret rotation while GitHub delivers queued or retried payloads signed with the old secret.
- `GITHUB_WEBHOOK_MAX_BYTES` _(Optional, default: `5242880` / 5 MB)_: Maximum allowable byte length for inbound webhook payloads. Exceeding requests are rejected immediately with HTTP 413.
- `GITHUB_APP_ID` _(Required)_: Numeric GitHub App ID used for authenticating API operations.
- `GITHUB_PRIVATE_KEY` _(Required)_: RSA private key (`.pem`) used to generate installation access tokens.
- `GITHUB_APP_URL` _(Required)_: Canonical public URL of the GitHub App.
- `NEXT_PUBLIC_APP_URL` / `AUTH_URL` _(Required)_: Public host URL where GitHub posts webhooks (`https://<domain>/api/webhooks/github`).

---

### Symptom

- Pull requests are opened or synchronized, but no automated security scan runs, no check runs appear on GitHub commits, and no PR comments are generated.
- The GitHub App settings page displays red failure badges on recent webhook deliveries.
- Typical HTTP status codes in the GitHub delivery log:
  - `401 Unauthorized`: Body returns `{"statusCode": 401, "message": "Invalid GitHub webhook signature"}` or `Missing or invalid x-hub-signature-256 header`.
  - `500 Internal Server Error`: Body returns `{"statusCode": 500, "message": "Server misconfiguration: GitHub webhook secret is missing."}` or `GITHUB_WEBHOOK_SECRET is not set`.
  - `413 Payload Too Large`: Body returns `{"statusCode": 413, "message": "Webhook payload exceeds the configured size limit"}`.
  - `400 Bad Request`: Body returns `Missing or invalid x-github-delivery header` or malformed JSON syntax.
  - Connection Timed Out / Failed: GitHub cannot establish a TCP/TLS connection to the configured Webhook URL.

---

### Likely Cause

1. **Secret Mismatch**: The secret in GitHub App settings differs from `GITHUB_WEBHOOK_SECRET` in `.env` (due to typos, copy-pasting surrounding whitespace, or trailing newline characters).
2. **Missing Secret in Server Environment**: `GITHUB_WEBHOOK_SECRET` was omitted from deployment environment variables.
3. **Unreachable Webhook URL**: In local development, the local tunnel (e.g. ngrok) expired or restarted with a new subdomain. In production, DNS records or ingress reverse proxies are misrouted or blocking POST requests to `/api/webhooks/github`.
4. **Oversized Pull Request Payload**: The PR metadata, large diffs, or commit arrays exceed `GITHUB_WEBHOOK_MAX_BYTES` (5 MB default).
5. **Missing Event Subscriptions**: The GitHub App is not subscribed to `Pull request`, `Installation`, or `Installation repositories` events.

---

### Check

1. **Inspect GitHub Delivery Log**:
   - Go to **GitHub &rarr; Settings &rarr; Developer Settings &rarr; GitHub Apps &rarr; [Your App]**.
   - In the left sidebar, click **Advanced** &rarr; **Recent Deliveries**.
   - Click the failed delivery (identified by its GUID delivery ID) to view:
     - **Headers**: Verify `X-GitHub-Delivery`, `X-GitHub-Event`, and `X-Hub-Signature-256` are present.
     - **Payload**: Inspect the event JSON.
     - **Response**: Check the exact status code and JSON error message returned by SecureFlow.
2. **Inspect Server Logs**:
   - Search application logs for `[SECURITY_WARNING]` tags:
     ```text
     [SECURITY_WARNING] GitHub webhook rejected: Invalid signature for delivery <deliveryId>
     [SECURITY_WARNING] GitHub webhook rejected: Missing or invalid x-hub-signature-256 header
     ```
3. **Verify Environment Variable in Running Process**:
   - Verify `GITHUB_WEBHOOK_SECRET` is populated and contains no stray quotes or whitespace:
     ```bash
     # Inspect variable length (avoid printing raw secret to console)
     echo -n "$GITHUB_WEBHOOK_SECRET" | wc -c
     ```
4. **Verify HMAC Verification Locally**:
   - Test signature generation with `openssl`:
     ```bash
     echo -n '{"zen":"test"}' | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET"
     ```

---

### Fix

1. **Rotate Webhook Secret (Zero-Downtime Rotation)**:
   - When rotating the webhook secret in GitHub App settings, use `GITHUB_WEBHOOK_SECRET_PREVIOUS` to avoid dropping in-flight or retried webhook deliveries:
     1. Generate a new secret:
        ```bash
        openssl rand -hex 20
        ```
     2. Update the application environment to accept both the new secret and the current one as previous:
        ```env
        GITHUB_WEBHOOK_SECRET="<new_secret>"
        GITHUB_WEBHOOK_SECRET_PREVIOUS="<old_secret>"
        ```
     3. Redeploy or restart SecureFlow.
     4. Update **Webhook Secret** in GitHub App Settings (**General &rarr; Webhook secret**) to the `<new_secret>`.
     5. Monitor server logs to confirm traffic transitions to the new secret:
        - When a delivery matches the previous secret, SecureFlow logs:
          `GitHub webhook signature verified using previous secret`.
        - When deliveries exclusively match the new secret:
          `GitHub webhook signature verified using current secret`.
     6. Once no deliveries match `previous` and all pending deliveries/retries have cleared, remove `GITHUB_WEBHOOK_SECRET_PREVIOUS` from the environment and redeploy.
2. **Synchronize Webhook Secret (Initial Setup / Manual Sync)**:
   - Generate a strong, clean secret if needed:
     ```bash
     openssl rand -hex 20
     ```
   - Update **Webhook Secret** in GitHub App Settings (**General &rarr; Webhook secret**).
   - Update `GITHUB_WEBHOOK_SECRET="<secret>"` in your `.env` or cloud secret manager, then redeploy/restart the service.
3. **Redeliver Failed Events via GitHub UI**:
   - Open **GitHub App &rarr; Advanced &rarr; Recent Deliveries**.
   - Select the failed delivery and click the **Redeliver** button.
   - _Why this works safely_: SecureFlow assigns BullMQ jobs a deterministic ID based on the delivery GUID (`jobId: webhookJobId(deliveryId)`) and specifies `replaceFailed: true`. Redelivering a previously failed webhook replaces the dead job and processes the scan cleanly without creating duplicates.
4. **Adjust Payload Size Cap (if HTTP 413)**:
   - If large PR diffs legitimately trigger HTTP 413, increase `GITHUB_WEBHOOK_MAX_BYTES` in `.env`:
     ```env
     GITHUB_WEBHOOK_MAX_BYTES=10485760   # 10 MB
     ```
5. **Update Expired Tunnel / Ingress URL**:
   - For local development with ngrok:
     ```bash
     ngrok http 9002
     ```
   - Copy the HTTPS URL and update **Webhook URL** in the GitHub App to `https://<subdomain>.ngrok-free.app/api/webhooks/github`.

---

## 2. Queue Stuck or Redis Unavailable

SecureFlow relies on BullMQ backed by Redis for offloading long-running scans, outbound webhooks, and SBOM processing from synchronous API requests.

### Relevant Environment Variables

- `REDIS_URL` _(Required in production)_: The connection string for the BullMQ queue and rate limiting (`redis://...` or `rediss://...` for TLS). In production, missing or malformed values throw `RedisConfigurationError` rather than silently defaulting to localhost.
- `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN` _(Optional)_: REST credentials for Upstash Redis (used for edge rate limiting). Both must be set or both unset.
- `NEXT_PUBLIC_MOCK_DB` _(Development only)_: When set to `"true"`, uses in-memory mock storage and mock Redis. _Strictly disallowed in production runtimes._

---

### Symptom

- Inbound webhooks return `202 {"status":"queued"}` or log `[DLQ_FALLBACK] BullMQ enqueue failed...`, but scans never progress, PR checks stay in `pending` or `in_progress`, and check run conclusions are never posted.
- The `/admin/queue` dashboard shows a growing count of `waiting` jobs and `0` active jobs.
- The web service fails startup in production with:
  ```text
  RedisConfigurationError: REDIS_URL is not set. The job queues need it in production; refusing to fall back to redis://localhost:6379.
  ```
- Application logs show Redis connection failures:
  ```text
  [ioredis] UnhandledError: Connection is closed.
  Error: connect ECONNREFUSED 127.0.0.1:6379
  [DLQ_FALLBACK] BullMQ enqueue failed for delivery ... Routing to Dead Letter Queue...
  ```
- PostgreSQL `WebhookDlq` table accumulates entries with `errorMessage: BullMQ enqueue failure`.

---

### Likely Cause

1. **Background Worker Process Not Running**: Next.js App Router (`npm run start` / `next start`) only accepts HTTP requests and enqueues jobs into BullMQ. Background execution requires running the worker process (`npm run worker` / `scripts/start-worker.ts`).
2. **Redis Outage or Unreachable Network**: The Redis instance is stopped, firewalled on port 6379, or experiencing connection timeouts.
3. **Protocol / TLS Mismatch in `REDIS_URL`**: Using `redis://` instead of `rediss://` with cloud Redis providers (such as Upstash or AWS ElastiCache) that mandate TLS/SSL.
4. **Redis Out-Of-Memory (OOM)**: Redis reaches `maxmemory` without an eviction policy, causing writes to throw `OOM command not allowed when used memory > 'maxmemory'`.
5. **Dead Letter Queue (DLQ) Trapping**: Repeatedly failed scan jobs hit maximum retries (2 attempts) and are routed to `vulnerability-scans-dlq` or database `WebhookDlq`.

---

### Check

1. **Verify the Worker Process is Running**:
   - **Local / Bare Metal**: Verify a terminal or systemd service is actively running `npm run worker`.
   - **Docker**: Run `docker compose ps` to ensure the `worker` container is healthy.
   - **Kubernetes**: Run `kubectl get pods -l app.kubernetes.io/component=worker` and check logs:
     ```bash
     kubectl logs -l app.kubernetes.io/component=worker -f
     ```
   - Expected startup logs:
     ```text
     🚀 BullMQ Worker (Inbound) successfully initialized and waiting for jobs...
     🚀 BullMQ Worker (Scans) started with concurrency=...
     🔁 DLQ Auto-Retry Worker started
     Worker running on 3000
     ```
2. **Test Redis Connectivity**:
   - Ping Redis directly with `redis-cli`:
     ```bash
     redis-cli -u "$REDIS_URL" ping
     # Expect: PONG
     ```
   - Check Redis memory usage:
     ```bash
     redis-cli -u "$REDIS_URL" info memory
     ```
3. **Inspect the Mission Control Queue Dashboard**:
   - Sign in as a user with the `ADMIN` role.
   - Navigate to `/admin/queue` to inspect real-time counters: `waiting`, `active`, `completed`, `failed` (DLQ), and `delayed`.
4. **Check the Database DLQ Fallback Table**:
   - Query PostgreSQL to see if webhooks bypassed Redis during an outage:
     ```sql
     SELECT "deliveryId", event, "errorMessage", "createdAt"
     FROM "WebhookDlq"
     ORDER BY "createdAt" DESC
     LIMIT 10;
     ```

---

### Fix

1. **Start the Background Worker**:
   - Run the worker alongside the Next.js app:
     ```bash
     # Using project npm script (reads .env automatically)
     npm run worker
     ```
   - In containerized environments, ensure your compose file or Kubernetes deployment (`helm/secureflow/templates/worker-deployment.yaml`) has active replicas running.
2. **Correct `REDIS_URL` Configuration**:
   - For TLS-protected Redis (Upstash, AWS ElastiCache, Redis Enterprise), ensure the URL uses `rediss://` (double 's'):
     ```env
     REDIS_URL="rediss://default:<token>@<host>:6379"
     ```
3. **Replay Stuck / Dead-Lettered Jobs**:
   - Navigate to `/admin/queue`.
   - Review failed deliveries in the Dead Letter Queue table.
   - Click **Requeue All** (or requeue individual jobs) to re-insert validated payloads into the active scan pipeline.
   - Note: The built-in `dlq-auto-retry` background worker automatically polls and recovers retryable DLQ jobs.
4. **Resolve Redis Memory Pressure**:
   - Configure a proper eviction policy in `redis.conf`:
     ```text
     maxmemory 512mb
     maxmemory-policy volatile-lru
     ```

---

## 3. Groq Errors and Rate Limits

SecureFlow uses Groq's high-speed inference engine (default model: `openai/gpt-oss-20b`) to scan PR diffs for hardcoded secrets, misconfigurations, and code vulnerabilities.

### Relevant Environment Variables

- `GROQ_API_KEY` _(Required)_: Authentication API key obtained from [console.groq.com](https://console.groq.com).
- `GROQ_MODEL` _(Optional, default: `openai/gpt-oss-20b`)_: Primary Groq model ID.
- `LLM_CACHE_TTL_SECONDS` _(Optional, default: `86400` / 24 hours)_: Time-to-live for caching LLM diff analysis in Redis.
- `LOCAL_AI_URL`, `LOCAL_AI_MODEL`, `LOCAL_AI_FALLBACK_MODELS` _(Optional)_: Configuration for local, air-gapped inference (e.g. Ollama or vLLM), bypassing Groq entirely.

---

### Symptom

- Pull request scans stall, fail after 30 seconds, or mark the GitHub Check Run as failed with `Scan execution error`.
- Server or worker logs display:
  - `429 Too Many Requests`:
    ```text
    ⚠️ Rate limit reached. Waiting X seconds...
    ⚠️ Rate limit persisted on model [openai/gpt-oss-20b]. Switching to fallback model [openai/gpt-oss-120b]...
    ```
  - `401 Unauthorized`:
    ```text
    Error: 401 Invalid API Key
    ```
  - `404 Not Found` / Deprecation Error:
    ```text
    NOT_FOUND: Model [llama-3.1-8b-instant] not found
    ```
  - `ScannerTimeoutError`:
    ```text
    ⚠️ LLM request exceeded 30s timeout. Retrying... (X attempts left)
    ```

---

### Likely Cause

1. **Groq Tier Quota Exceeded (429)**: The Requests Per Minute (RPM) or Tokens Per Minute (TPM) limit on your Groq tier was exceeded due to concurrent PR scans or very large diffs.
2. **Expired or Invalid API Key**: `GROQ_API_KEY` was deleted, rotated in the Groq console, or pasted with leading/trailing characters.
3. **Configured Model Deprecated / Shut Down**: Older Groq models (e.g. `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`) were decommissioned by Groq. Using them produces 404 / `model_not_found`.
4. **Large Diff Token Exhaustion**: Massive PRs containing thousands of lines of generated files, package locks, or minified assets overload LLM context windows and exhaust timeout budgets (30s per request).
5. **Redis Cache Offline**: Redis is unavailable, disabling the LLM cache and forcing every repeated diff chunk to execute a fresh API call.

---

### Check

1. **Verify Groq API Key Validity and Model List**:
   - Query Groq's model catalog using `curl`:
     ```bash
     curl -s https://api.groq.com/openai/v1/models \
       -H "Authorization: Bearer $GROQ_API_KEY" | grep "id"
     ```
   - If this returns `401 Unauthorized`, your key is invalid.
2. **Check Model Fallback Activity in Logs**:
   - Search the worker logs for failover transitions:
     ```bash
     grep -i "fallback model" worker.log
     ```
   - SecureFlow implements an automatic fallback chain:
     `openai/gpt-oss-20b` &rarr; `openai/gpt-oss-120b` &rarr; `qwen/qwen3.6-27b`.
3. **Inspect PR File Scope & Diffs**:
   - Check if the PR being scanned contains huge files (e.g., `package-lock.json`, minified bundles, `.map` files) that should be excluded.
4. **Check Quota in Groq Cloud Console**:
   - Open [console.groq.com](https://console.groq.com) &rarr; **Limits** / **Usage** to inspect your active tier, TPM, and RPM utilization.

---

### Fix

1. **Set Active, Supported Model**:
   - Ensure `GROQ_MODEL` points to an active model (or unset it to default to `openai/gpt-oss-20b`):
     ```env
     GROQ_MODEL="openai/gpt-oss-20b"
     ```
   - _Avoid deprecated models_: Do not use decommissioned models such as `llama-3.1-8b-instant`.
2. **Exclude Non-Code / Generated Files**:
   - Create or update `.secureflowignore` in the target repository's root to ignore lockfiles and build outputs:
     ```text
     package-lock.json
     pnpm-lock.yaml
     yarn.lock
     *.min.js
     dist/**
     build/**
     .next/**
     ```
   - This dramatically cuts token consumption and prevents 429 rate limit errors.
3. **Enable Redis LLM Caching**:
   - Ensure `REDIS_URL` is healthy so `LLM_CACHE_TTL_SECONDS` (default: 86,400s / 24h) can cache identical diff evaluations and eliminate redundant Groq queries.
4. **Switch to Air-Gapped Local Inference (Optional)**:
   - If Groq rate limits are a persistent constraint, route scans to a local Ollama or vLLM server:
     ```env
     LOCAL_AI_URL="http://localhost:11434/v1"
     LOCAL_AI_MODEL="llama3"
     LOCAL_AI_FALLBACK_MODELS="qwen2.5-coder:7b"
     ```

---

## 4. Database Pooling Errors

SecureFlow uses PostgreSQL with Prisma ORM and `@prisma/adapter-pg` backed by `pg.Pool`. Serverless functions and background workers maintain connection pools to PostgreSQL.

### Relevant Environment Variables

- `DATABASE_POOL_URL` _(Recommended for production runtime)_: Pooled PostgreSQL connection string (PgBouncer or Neon connection pooler). SecureFlow runtime queries prioritize this over `DATABASE_URL`.
- `DATABASE_URL` _(Required)_: Direct PostgreSQL connection string. Used by Prisma CLI for running migrations (`npm run db:migrate`) and schema pushes, and as runtime fallback.
- `DB_POOL_MAX` _(Optional, default: `10`, clamped between `1` and `100`)_: Maximum connections allocated per process instance pool.
- `NEXT_PUBLIC_MOCK_DB` _(Development only)_: In-memory mock database flag. _Strictly refused in production runtime._

---

### Symptom

- Database operations fail intermittently or during traffic bursts with errors:
  ```text
  FATAL: sorry, too many clients already
  FATAL: remaining connection slots are reserved for non-replication superuser connections
  Connection terminated unexpectedly
  Error: connect ETIMEDOUT
  ```
- Application logs when unconfigured:
  ```text
  role "nextjs" does not exist
  No database connection string is configured. Set DATABASE_URL (or DATABASE_POOL_URL to route through a connection pooler)...
  ```
- Clamping and parsing warnings in logs:
  ```text
  DB_POOL_MAX="abc" is not a number; using 10.
  DB_POOL_MAX=200 exceeds the per-instance ceiling of 100; using 100. Every instance opens its own pool, so this multiplies.
  ```
- Next.js serverless functions hit 504 gateway timeouts waiting for an available database connection.

---

### Likely Cause

1. **Missing `DATABASE_POOL_URL` in Serverless Deployments**: Pointing serverless API routes directly to PostgreSQL via `DATABASE_URL` instead of a connection pooler (e.g. PgBouncer or Neon Pooler). Because serverless instances scale out concurrently, 20 instances with a default pool of 10 create up to 200 connections, instantly exhausting PostgreSQL's `max_connections`.
2. **`DB_POOL_MAX` Set Too High**: Setting `DB_POOL_MAX` to an excessive number across multiple instances/workers, saturating total database connection capacity.
3. **Unset Connection String**: Neither `DATABASE_POOL_URL` nor `DATABASE_URL` is set in the environment. `pg.Pool` defaults to a local Unix socket under the current OS user (e.g. `nextjs`), producing `role "nextjs" does not exist`.
4. **Serverless Database Auto-Suspend Cold Starts**: Cloud databases like Neon auto-suspend after inactivity. The first query after suspension must wait for compute activation (connection timeout is 10,000 ms by default).

---

### Check

1. **Verify Connection Strings**:
   - Check `.env` or production secrets:
     - `DATABASE_POOL_URL`: Should point to the pooled endpoint (e.g., `-pooler` hostname on Neon, or port 6543 on PgBouncer/Supabase).
     - `DATABASE_URL`: Direct endpoint (port 5432) for running Prisma migrations.
2. **Query Current PostgreSQL Connection Usage**:
   - Connect via `psql` and check active vs allowed connections:
     ```sql
     -- Total active connections by state
     SELECT state, count(*) FROM pg_stat_activity GROUP BY state;

     -- Available connection slots
     SELECT max_conn, used, resv, max_conn - used - resv AS free
     FROM
       (SELECT count(*) AS used FROM pg_stat_activity) q1,
       (SELECT setting::int AS resv FROM pg_settings WHERE name='superuser_reserved_connections') q2,
       (SELECT setting::int AS max_conn FROM pg_settings WHERE name='max_connections') q3;
     ```
3. **Inspect Application Logger**:
   - Look for component logs from `prisma`:
     ```text
     Idle Postgres client errored; the pool will discard it
     ```
   - (Note: SecureFlow registers an idle client error listener so discarded idle connections do not crash the Node.js process).

---

### Fix

1. **Configure `DATABASE_POOL_URL` for Production**:
   - In cloud serverless environments (Vercel, AWS Lambda, Cloud Run), configure `DATABASE_POOL_URL` to route runtime queries through a pooler:
     ```env
     # Direct URL for Prisma CLI migrations:
     DATABASE_URL="postgresql://user:pass@ep-direct.aws.neon.tech/neondb?sslmode=verify-full"

     # Pooled URL for application runtime queries:
     DATABASE_POOL_URL="postgresql://user:pass@ep-pooler.aws.neon.tech/neondb?sslmode=verify-full"
     ```
2. **Tune `DB_POOL_MAX` to Fit Your Deployment**:
   - Configure `DB_POOL_MAX` based on your instance concurrency:
     ```env
     DB_POOL_MAX=5
     ```
   - **Sizing Rule**:
     $$\text{Total Connections} = (\text{App Instances} \times \text{DB\_POOL\_MAX}) + (\text{Worker Replicas} \times \text{DB\_POOL\_MAX})$$
     Ensure this total remains comfortably below your PostgreSQL `max_connections` limit (leaving buffer for migrations and admin tools).
3. **Resolve Missing Connection String**:
   - If seeing `role "nextjs" does not exist`, ensure `DATABASE_URL` is defined and passed to the container/runtime environment.

---

## 5. Rate-Limit Buckets Wrong Behind a Proxy

SecureFlow uses an edge proxy and route-level rate limiting (`src/lib/client-ip.ts`) to prevent API abuse, denial-of-service, and LLM credit exhaustion. Client identities are derived by safely inspecting the `X-Forwarded-For` chain.

### Relevant Environment Variables

- `TRUSTED_PROXY_HOP_COUNT` _(Optional, default: `0`)_: Number of trusted reverse proxies between the internet and SecureFlow. Set `1` behind a single proxy (Vercel, Render, Fly.io, single NGINX ingress). Set `2` behind Cloudflare in front of Vercel/NGINX.
- `TRUSTED_PROXY_IPS` _(Optional)_: Comma-separated list of trusted proxy IP addresses or IPv4 CIDR blocks (e.g. `10.0.0.0/8,192.168.1.1`). Used when traffic arrives across variable ingress paths instead of a fixed hop count.

---

### Symptom

- **Symptom A: Global Rate-Limiting ("Noisy Neighbor")**:
  - Legitimate users randomly receive HTTP 429 ("Rate limit exceeded") when navigating the dashboard or triggering API endpoints, even after making only one request.
  - A single active user throttles all other users across the company.
  - The server logs a one-time warning on startup:
    ```text
    [client-ip] Forwarding headers are present but TRUSTED_PROXY_HOP_COUNT / TRUSTED_PROXY_IPS are not set, so every client shares one rate-limit bucket. Set TRUSTED_PROXY_HOP_COUNT=1 behind a single proxy (Vercel, Render, nginx), or 0 if the app is exposed directly.
    ```
  - Redis rate limit keys collapse into `rate-limit:<tier>:unknown`.
- **Symptom B: Spoofed IP Bypasses Rate Limits**:
  - Malicious callers inject custom `X-Forwarded-For` headers with randomized IPs (`1.2.3.4`, `1.2.3.5`) and completely bypass rate limits because the application trusted the left-most IP.
- **Symptom C: Intermediate Proxy IP Attributed**:
  - In Cloudflare + Vercel/NGINX deployments, all clients are bucketed under Cloudflare's egress IPs rather than the user's IP address.

---

### Likely Cause

1. **`TRUSTED_PROXY_HOP_COUNT` is Unset or `0` Behind a Reverse Proxy**: SecureFlow defaults to `0` (secure-by-default). When unset, the app ignores `X-Forwarded-For` to prevent header spoofing. As a result, all requests resolve to the sentinel value `UNKNOWN_CLIENT_IP` (`"unknown"`), causing every client behind the proxy to share one rate-limit quota.
2. **Hop Count Mismatch in Multi-Tier Topologies**:
   - Setting `TRUSTED_PROXY_HOP_COUNT=1` when traffic passes through both Cloudflare and Vercel (2 hops) extracts Cloudflare's proxy IP instead of the client IP.
3. **Variable Ingress Paths**: Traffic enters from both an internal corporate VPN and an external edge CDN with different hop counts, making a single integer hop count inaccurate.

---

### Check

1. **Check Application Logs for Proxy Warning**:
   - Inspect startup logs for the `[client-ip]` warning.
2. **Inspect the `X-Forwarded-For` Header**:
   - Check the incoming chain in your access logs or ingress controller:
     ```text
     X-Forwarded-For: <client_ip>, <cloudflare_ip>, <ingress_ip>
     ```
   - In this 2-hop scenario:
     - Hop count = 1 selects `<ingress_ip>` or `<cloudflare_ip>`.
     - Hop count = 2 correctly extracts `<client_ip>`.
3. **Inspect Redis Rate-Limit Keys**:
   - Query Redis for active rate limit counters:
     ```bash
     redis-cli -u "$REDIS_URL" keys "rate-limit:*"
     ```
   - **Problematic**: Keys look like `rate-limit:standard:unknown` (all clients sharing one bucket).
   - **Healthy**: Keys look like `rate-limit:standard:203.0.113.195` (keyed to individual client IPs).

---

### Fix

1. **Set `TRUSTED_PROXY_HOP_COUNT` According to Your Architecture**:
   Configure `TRUSTED_PROXY_HOP_COUNT` in your deployment environment variables:

   | Ingress Architecture                                                      | `TRUSTED_PROXY_HOP_COUNT` Value         |
   | :------------------------------------------------------------------------ | :-------------------------------------- |
   | **Directly Exposed** (local development, bare VM without reverse proxy)   | `0` (explicitly set to silence warning) |
   | **Single Reverse Proxy** (Vercel, Render, Fly.io, AWS ALB, NGINX ingress) | `1`                                     |
   | **Double Proxy** (Cloudflare CDN in front of Vercel, Render, or NGINX)    | `2`                                     |

   Example `.env`:

   ```env
   TRUSTED_PROXY_HOP_COUNT=1
   ```

2. **Use `TRUSTED_PROXY_IPS` for Dynamic / Hybrid Ingress**:
   - If traffic arrives through varying hop counts (e.g. internal VPC subnets and external load balancers), specify `TRUSTED_PROXY_IPS` with bare IPs and CIDRs:
     ```env
     TRUSTED_PROXY_IPS="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
     ```
   - SecureFlow walks the `X-Forwarded-For` chain from right to left, skipping trusted proxy addresses and selecting the first untrusted IP as the genuine client.

3. **Verify Resolution**:
   - Make a test request and verify Redis keyspace:
     ```bash
     redis-cli -u "$REDIS_URL" keys "rate-limit:*"
     ```
   - Verify that individual IP addresses are now recorded and the one-time console warning no longer appears.

---

## 🛠️ Quick Environment Variables Verification Checklist

Use this checklist to verify your deployment configuration when diagnosing system issues:

```text
[ ] GITHUB_WEBHOOK_SECRET is identical in GitHub App settings and SecureFlow .env
[ ] GITHUB_WEBHOOK_MAX_BYTES is sized for your repository diff volumes (default 5MB)
[ ] REDIS_URL is configured (using rediss:// for cloud/TLS Redis) and worker process is active
[ ] GROQ_API_KEY is valid and GROQ_MODEL points to an active model (e.g. openai/gpt-oss-20b)
[ ] DATABASE_POOL_URL is configured for serverless production queries (PgBouncer/Neon Pooler)
[ ] DB_POOL_MAX is tuned to stay within PostgreSQL max_connections (default 10)
[ ] TRUSTED_PROXY_HOP_COUNT is set to 1 (single proxy) or 2 (Cloudflare + proxy) in production
```
