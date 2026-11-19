import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { computeHmacSignature } from './helpers/signature.js';

// Custom metric tracking for granular threshold and result analysis
const successfulDeliveries = new Counter('webhook_successful_deliveries');
const failedDeliveries = new Counter('webhook_failed_deliveries');
const deliveryDuration = new Trend('webhook_delivery_duration', true);
const rateLimitedCount = new Counter('webhook_rate_limited');

/**
 * Performance Thresholds & Execution Plan
 *
 * Requirements:
 *  - Ramping load to simulate realistic GitHub webhook burst traffic.
 *  - p95 response time under 500ms (prevents GitHub 10s webhook delivery timeouts).
 *  - Error rate under 1% (http_req_failed < 0.01).
 */
export const options = {
  stages: [
    { duration: '10s', target: 5 },  // Ramp-up to 5 concurrent virtual users
    { duration: '20s', target: 15 }, // Ramp-up to 15 concurrent virtual users
    { duration: '20s', target: 25 }, // Sustained burst peak at 25 concurrent virtual users
    { duration: '10s', target: 0 },  // Ramp-down to 0
  ],
  thresholds: {
    // 95% of webhook requests must respond in under 500ms
    http_req_duration: ['p(95)<500'],
    // Overall HTTP failure rate (non-2xx responses) must stay below 1%
    http_req_failed: ['rate<0.01'],
    // Custom check success rate
    checks: ['rate>0.99'],
  },
};

// Target configuration with defaults for local Docker Compose environment
const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:9002';
// Dedicated test secret: NEVER use production or real secrets
const WEBHOOK_SECRET = __ENV.GITHUB_WEBHOOK_SECRET || 'test-webhook-secret-load-testing-only';
const WEBHOOK_PATH = '/api/webhooks/github';

const webhookEndpoint = TARGET_URL.endsWith(WEBHOOK_PATH)
  ? TARGET_URL
  : `${TARGET_URL.replace(/\/+$/, '')}${WEBHOOK_PATH}`;

/**
 * Generate a synthetic RFC4122 v4 UUID for the `X-GitHub-Delivery` header.
 *
 * Each webhook delivery requires a distinct delivery ID so that deduplication
 * in Redis (`isDuplicateDelivery`) processes the delivery through the full
 * verification, parsing, and queueing pipeline.
 */
function generateDeliveryId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a synthetic GitHub `pull_request` event payload using fake repository data.
 *
 * Contains no real repository names, tokens, secrets, or PII.
 */
function generateSamplePullRequestPayload(vu, iter) {
  const prNumber = vu * 10000 + iter;
  return JSON.stringify({
    action: 'opened',
    number: prNumber,
    pull_request: {
      id: 100000 + prNumber,
      number: prNumber,
      state: 'open',
      title: `Load test synthetic pull request #${prNumber}`,
      body: 'Synthetic payload generated for automated performance and throughput testing.',
      head: {
        sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
        ref: `feat/load-test-branch-${prNumber}`,
      },
      base: {
        sha: 'b52d96c9c647b0a88b56f96cfb2f3fb0a9f5c4f2',
        ref: 'main',
      },
      user: {
        login: 'loadtest-bot',
        id: 999001,
      },
      changed_files: 3,
    },
    repository: {
      id: 888001,
      name: 'sample-repo',
      full_name: 'loadtest-org/sample-repo',
      owner: {
        login: 'loadtest-org',
        id: 888000,
      },
      private: false,
    },
    installation: {
      id: 777001,
    },
    sender: {
      login: 'loadtest-bot',
      id: 999001,
    },
  });
}

export default function () {
  const deliveryId = generateDeliveryId();
  const payload = generateSamplePullRequestPayload(__VU, __ITER);
  const signature = computeHmacSignature(payload, WEBHOOK_SECRET);

  // Simulated client IP from GitHub webhook IP pool for proxy-aware rate limit distribution
  const clientIp = `192.30.252.${((__VU - 1) % 250) + 1}`;

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'GitHub-Hookshot/k6-load-test',
    'X-GitHub-Event': 'pull_request',
    'X-GitHub-Delivery': deliveryId,
    'X-Hub-Signature-256': signature,
    'X-Forwarded-For': clientIp,
  };

  const startTime = Date.now();
  const res = http.post(webhookEndpoint, payload, { headers });
  const latency = Date.now() - startTime;
  deliveryDuration.add(latency);

  const passed = check(res, {
    'status is 202 (queued) or 200': (r) => r.status === 202 || r.status === 200,
    'signature accepted (not 401)': (r) => r.status !== 401,
    'not rate limited (not 429)': (r) => r.status !== 429,
    'server error avoided (not 5xx)': (r) => r.status < 500,
  });

  if (passed) {
    successfulDeliveries.add(1);
  } else {
    failedDeliveries.add(1);
    if (res.status === 429) {
      rateLimitedCount.add(1);
    }
  }

  // Paced pause between iterations to simulate burst distribution
  sleep(0.1);
}
