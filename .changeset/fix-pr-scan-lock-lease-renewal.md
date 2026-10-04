---
"secureflow": patch
---

Keep the per-PR scan lock held for as long as the scan runs. The lock was a fixed five-minute lease with no renewal, but a scan is not bounded by that (each LLM call may take two minutes and is retried), so a slow scan lost its lock mid-run and the next delayed job for the same PR started concurrently, producing the duplicate scans and comments the lock exists to prevent. The same flat lease also blocked a PR for the full five minutes after a worker crash. The lease is now 60 seconds, renewed every 20 seconds by a heartbeat that only extends a lock it still owns (atomic compare-and-extend in Lua), and stopped before the lock is released.
