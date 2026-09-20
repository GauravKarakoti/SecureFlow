---
"secureflow": patch
---

Make DLQ requeues actually re-run the webhook. The failed original still held its `delivery-<id>` job id in the main queue, so BullMQ deduplicated the requeue against it and nothing was added — for both the admin "Requeue" actions and the automated DLQ retry worker.
