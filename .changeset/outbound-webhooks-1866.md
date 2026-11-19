---
"secureflow": minor
---

Support signed outbound webhooks for scan and finding events (#1866). Allows users to register one or more HTTPS endpoints with selected events (`scan.completed`, `scan.blocked`, `finding.created`, `finding.dismissed`). Requests are signed with an `X-SecureFlow-Signature` HMAC-SHA256 header using a per-endpoint secret shown once at registration, and include event ID and timestamp for replay protection. Delivery is asynchronous with short timeout, retries with exponential backoff, and a delivery log visible in Settings. Enforces strict SSRF protection by blocking private, loopback, and link-local addresses upon saving and dispatch, with zero code snippets or secrets included in payloads.
