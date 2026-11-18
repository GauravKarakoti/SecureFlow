---
"secureflow": minor
---

Add k6 load test suite for webhook endpoint with documented thresholds (#1810). Adds `load-tests/webhook.k6.js` and `load-tests/helpers/signature.js` to simulate ramping GitHub pull request webhook traffic with authentic HMAC-SHA256 signatures and synthetic repository data, defines p95 response time (< 500ms) and failure rate (< 1%) thresholds, adds an opt-in manual GitHub Actions workflow (`.github/workflows/webhook-load-test.yml`), and documents local Docker Compose execution and metric interpretation in `docs/load-testing.md`.
