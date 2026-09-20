---
"secureflow": patch
---

Fail a scan when a chunk of the pull request cannot be analysed, instead of skipping that chunk. `processScanJob` caught the error `scanner.scanPullRequest` throws once its retries are exhausted and carried on, so an unavailable LLM produced a `PASS` check run with zero findings on both the webhook and the queued scan paths. It now throws `ScanIncompleteError`, which fails the job.
