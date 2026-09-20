---
"secureflow": patch
---

Fix SBOM scans that hit a transient error reporting CLEAN on retry: the worker now returns the ScanJob to PENDING so the retry can claim it and actually scan the manifest.
