---
"secureflow": patch
---

Let only one request probe the dependency while the circuit breaker is HALF_OPEN. Every caller in flight when `resetTimeoutMs` elapsed was admitted together, so the rate limiter's Redis breaker stopped shielding callers at exactly the moment Redis was least able to answer.
