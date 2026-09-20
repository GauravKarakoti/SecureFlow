---
"secureflow": patch
---

Fix pull request SBOM scans never being queued: the webhook built BullMQ job ids containing `:`, which BullMQ rejects, so every manifest scan failed before reaching the worker.
