---
"secureflow": patch
---

Stop the public leaderboard endpoint from returning raw database error messages, which can name the database host, to unauthenticated callers over JSON and SSE.
