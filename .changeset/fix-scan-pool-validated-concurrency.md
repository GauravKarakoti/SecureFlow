---
"secureflow": patch
---

The scan worker now uses the `SCAN_WORKER_CONCURRENCY` value validated at startup. `scanWorkerPool` re-read the variable with a bare `parseInt`, so an empty value (`SCAN_WORKER_CONCURRENCY=`) passed validation (falling back to 3), but it reached BullMQ as `NaN` and crashed the worker process with `concurrency must be a finite number greater than 0`.
