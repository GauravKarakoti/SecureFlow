---
"secureflow": patch
---

Declare `timeoutMs` on `RetryConfig` so the per-attempt AI timeout added in #988 type-checks and is actually configurable, and name the 15s default `DEFAULT_ATTEMPT_TIMEOUT_MS`.
