---
"secureflow": patch
---

`/api/health` no longer calls Groq with the server's API key on every request. The endpoint is public and exempt from rate limiting, so anyone could use it to send an unlimited stream of authenticated requests on that key. The Groq probe result is now reused for 60 seconds, and concurrent checks share one request. Adds tests for `health-check.ts` (0% → 100%).
