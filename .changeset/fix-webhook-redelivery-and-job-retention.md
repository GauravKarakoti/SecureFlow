---
"secureflow": patch
---

Let GitHub redeliver a failed webhook, and stop keeping every webhook payload in Redis forever. The ingest route enqueues under `delivery-<id>`, and a delivery whose job exhausted its attempts keeps that job ID, so GitHub's "Redeliver" button (which reuses the delivery ID) was deduplicated against the dead job, answered `202 queued`, and never ran. Only the DLQ requeue paths knew to replace a failed job; the route now does too, while waiting, active and completed jobs still collapse a replay. Separately, `github-webhooks` was the only queue with no `removeOnComplete`/`removeOnFail`, so BullMQ kept every job, full payload included, indefinitely. It now keeps completed jobs for 24 hours and failed jobs for 48 hours, matching the scan and SBOM queues; replay safety is unaffected because completed deliveries are recorded in `WebhookEvent` and failed ones in the DLQ.
