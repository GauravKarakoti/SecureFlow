---
"secureflow": minor
---

Handle GitHub `check_run` and `check_suite` rerequested events to trigger manual scan re-runs (#1863). Clicking "Re-run" on a SecureFlow check run or check suite starts a new scan that updates the existing check run and pull request comment. Foreign check runs from third-party apps are safely ignored. Re-requests share the same signature verification, HMAC checking, delivery deduplication, and per-PR distributed locking as the synchronize path, preventing duplicate concurrent scans under rapid clicks. Audit logs record manual re-run triggers.
