---
"secureflow": patch
---

Scan jobs that fail with `UnrecoverableError` (a results-persistence failure or an unusable installation id) are now recorded in the scan DLQ. BullMQ ends the retry chain after that first attempt, so `attemptsMade` (1) never reached `attempts` (2), and those jobs disappeared without a DLQ entry. The outbound and SBOM workers already handled this case.
