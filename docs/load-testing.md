# Webhook Load Testing & Performance Benchmarks

This guide explains how to run the automated k6 load testing suite for SecureFlow's GitHub webhook ingestion pipeline (`/api/webhooks/github`), verify response time and error rate thresholds, and interpret results.

---

## 1. Overview & Performance Goals

Inbound GitHub webhooks must ingest sudden bursts of pull request events (e.g. bulk merges, monorepo pushes, CI re-runs) and respond promptly with `202 Accepted` (`{"status":"queued"}`). GitHub enforces a strict 10-second delivery timeout; if the endpoint responds slowly or stumbles during high-volume events, GitHub marks deliveries as failed and pauses webhooks.

The load test suite (`load-tests/webhook.k6.js`) measures performance and prevents regressions across critical ingress stages:

- **HMAC-SHA256 Signature Verification**: Constant-time crypto validation using the configured webhook secret.
- **Request Size & Header Normalization**: Enforcing byte caps and delivery ID constraints before body parsing.
- **Deduplication Check**: Redis `isDuplicateDelivery` atomic verification.
- **Payload Parsing**: JSON parsing into typed structures.
- **BullMQ Delegation**: Enqueueing jobs onto the `webhookQueue`.

---

## 2. Defined Thresholds

The k6 test defines strict, automated pass/fail thresholds:

| Metric                        | Target / SLA           | Rationale                                                                                                                                          |
| :---------------------------- | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`http_req_duration` (p95)** | **`< 500 ms`**         | 95% of incoming webhook requests must be verified and enqueued in under 500ms, well clear of GitHub's timeout.                                     |
| **`http_req_failed`**         | **`< 1%` (`< 0.01`)**  | Overall HTTP failure rate (status codes outside 2xx/3xx) must not exceed 1%.                                                                       |
| **`checks`**                  | **`> 99%` (`> 0.99`)** | Custom assertion rate: status is `202`/`200`, signatures accepted (`≠ 401`), rate limits respected (`≠ 429`), and server errors avoided (`< 500`). |

---

## 3. Security & Synthetic Data Isolation

- **Dedicated Test Secret**: The load test uses a dedicated, non-production secret (default: `test-webhook-secret-load-testing-only`). **Never run load tests using production secrets.**
- **Correct Signatures**: Each request generates an authenticated `X-Hub-Signature-256: sha256=<hex>` header using `load-tests/helpers/signature.js`, exercising the real HMAC validation path.
- **Fake Repository Data**: Payloads contain synthetic repository (`loadtest-org/sample-repo`) and pull request information without referencing real repositories, user tokens, or PII.
- **Distinct Delivery IDs**: Each iteration mints a unique RFC4122 v4 UUID for `X-GitHub-Delivery`, preventing all deliveries from collapsing into a single Redis deduplication key.

---

## 4. Running Locally Against Docker Compose

### Step 1: Start the Local Stack with Docker Compose

Ensure the local environment is configured with the test secret in `.env`:

```env
GITHUB_WEBHOOK_SECRET="test-webhook-secret-load-testing-only"
TRUSTED_PROXY_HOP_COUNT=1
```

Start the containers (PostgreSQL, Redis, and SecureFlow runner):

```bash
docker compose up -d
```

Verify that the application container is healthy:

```bash
docker compose ps
# Ensure 'app', 'db', and 'redis' report healthy status
```

### Step 2: Execute the Load Test

#### Option A: Using Local `k6` Binary

If you have [k6 installed](https://k6.io/docs/get-started/installation/):

```bash
# Using npm shortcut
npm run test:load

# Or directly with k6 CLI
k6 run load-tests/webhook.k6.js
```

To test against a custom host or custom test secret:

```bash
k6 run -e TARGET_URL=http://localhost:9002 -e GITHUB_WEBHOOK_SECRET=test-webhook-secret-load-testing-only load-tests/webhook.k6.js
```

#### Option B: Using Docker (No Local `k6` Installation Required)

Run k6 directly via the official Grafana Docker container:

```bash
# Using npm shortcut
npm run test:load:docker

# Or via Docker CLI directly
docker run --rm -i \
  -v "${PWD}/load-tests:/load-tests" \
  --network=host \
  -e TARGET_URL=http://localhost:9002 \
  -e GITHUB_WEBHOOK_SECRET=test-webhook-secret-load-testing-only \
  grafana/k6 run /load-tests/webhook.k6.js
```

> **Note for Windows/macOS Docker Desktop**: When running Docker Desktop without host networking, point `TARGET_URL` to `http://host.docker.internal:9002`.

#### Option C: Quick Smoke Test

To run a fast 10-second verification with 2 virtual users:

```bash
k6 run --vus 2 --duration 10s load-tests/webhook.k6.js
```

---

## 5. How to Read and Interpret Output

When the test completes, k6 prints a summary report in your terminal:

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: load-tests/webhook.k6.js
     output: -

  scenarios: (100.00%) 1 scenario, 25 max VUs, 1m30s max duration (incl. graceful stop):
           * default: Up to 25 looping VUs for 1m0s over 4 stages (gracefulRampDown: 30s)

     ✓ status is 202 (queued) or 200
     ✓ signature accepted (not 401)
     ✓ not rate limited (not 429)
     ✓ server error avoided (not 5xx)

     checks.........................: 100.00% ✓ 4800      ✗ 0
     data_received..................: 720 kB  12 kB/s
     data_sent......................: 2.1 MB  35 kB/s
   ✓ http_req_duration..............: avg=42.15ms min=12.10ms med=38.40ms max=189.20ms p(90)=68.10ms p(95)=92.30ms
       { expected_response:true }...: avg=42.15ms min=12.10ms med=38.40ms max=189.20ms p(90)=68.10ms p(95)=92.30ms
   ✓ http_req_failed................: 0.00%   ✓ 0         ✗ 1200
     http_reqs......................: 1200    20.00/s
     iteration_duration.............: avg=143.10ms min=112.50ms med=139.20ms max=291.40ms p(90)=171.20ms p(95)=196.50ms
     iterations.....................: 1200    20.00/s
     vus............................: 1       min=0       max=25
     vus_max........................: 25      min=25      max=25
     webhook_delivery_duration......: avg=42.15ms min=12.10ms med=38.40ms max=189.20ms p(90)=68.10ms p(95)=92.30ms
     webhook_failed_deliveries......: 0       0.00/s
     webhook_rate_limited...........: 0       0.00/s
     webhook_successful_deliveries..: 1200    20.00/s
```

### Key Metrics Explained

1. **Threshold Checks (`✓` vs `✗`)**:
   - `✓ http_req_duration: p(95)<500`: Green checkmark indicates that 95% of responses completed within 500ms.
   - `✓ http_req_failed: rate<0.01`: Green checkmark indicates error rate remained below 1%.
2. **`webhook_delivery_duration`**:
   - Quantifies the end-to-end HTTP latency observed by the client.
3. **`webhook_rate_limited`**:
   - Count of `429 Too Many Requests` responses received. Under expected loads with distributed proxy IPs, this should remain `0`.
4. **`webhook_successful_deliveries`**:
   - Total number of successfully admitted and enqueued webhook events (`202 Accepted` or `200 OK`).

### Troubleshooting Threshold Failures

- **`http_req_duration` p95 > 500ms**:
  - High Redis connection latency or connection pool contention.
  - Slow crypto calculation under high CPU constraints.
  - Uncached or unbounded synchronous disk/DB reads in the request handler.
- **`http_req_failed` > 1% (401 Unauthorized)**:
  - The secret provided via `GITHUB_WEBHOOK_SECRET` does not match the secret running in the target container.
- **`http_req_failed` > 1% (429 Too Many Requests)**:
  - If testing without proxy headers, all virtual users share a single client IP bucket (`50` requests per 60s limit). Ensure `TRUSTED_PROXY_HOP_COUNT=1` is set in the server's `.env`.
- **`http_req_failed` > 1% (500 Internal Server Error)**:
  - Redis connection failure or unhandled exception during queue insertion. Check `docker compose logs app`.

---

## 6. Manual GitHub Actions Workflow (Opt-In)

The load test is deliberately **excluded** from standard push/pull request CI pipelines to prevent resource waste and false negatives from shared runner latency.

An opt-in workflow is available under **`.github/workflows/webhook-load-test.yml`**:

- Triggerable via **GitHub Actions UI** (`Run workflow` button) or the GitHub CLI:
  ```bash
  gh workflow run webhook-load-test.yml -f target_url=http://localhost:9002 -f duration=30s
  ```
- Automatically provisions a clean Docker Compose environment on the runner, executes the k6 test, validates thresholds, and tears down containers upon completion.
