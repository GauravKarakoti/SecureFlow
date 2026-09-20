---
"secureflow": patch
---

The BullMQ and rate-limit Redis clients no longer share a development-time singleton. Both cached themselves on `globalThis.redis`, so outside production whichever module loaded first handed its client to the other, and a BullMQ `Worker` given the rate-limit client (`maxRetriesPerRequest: 3`) throws. The rate limiter and health probe could also end up with the queue's never-give-up client, or with its `NEXT_PUBLIC_MOCK_DB` stub.
