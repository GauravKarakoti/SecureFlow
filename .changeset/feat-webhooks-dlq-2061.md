---
"secureflow": minor
---

feat(webhooks): dead-letter queue (DLQ), durable replay, and circuit breaker for outbound webhook deliveries (#2061)

- Added `src/lib/webhooks/circuit-breaker.ts` implementing destination host circuit breakers with `CLOSED` -> `OPEN` -> `HALF_OPEN` state transitions, failure thresholds, and cooldown timers to prevent cascading socket exhaustion.
- Integrated circuit breaker pre-flight checks and full-jitter exponential backoff in `src/lib/webhooks/outbound-dispatcher.ts`.
- Added `src/lib/webhooks/dlq.ts` providing a durable dead-letter queue (DLQ) state machine, quarantine tracking, and single/batch replay capabilities.
- Added admin management API routes for DLQ inspection and replay at `GET/DELETE /api/webhooks/dlq`, `POST /api/webhooks/dlq/replay`, and `POST /api/webhooks/dlq/[id]/replay`.
