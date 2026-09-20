---
"secureflow": patch
---

Fix SBOM scan deduplication never matching an earlier enqueue: the audit lookup used a different `action` casing than the sanitizer stores, and the stored dedupe key had its commit SHA redacted.
