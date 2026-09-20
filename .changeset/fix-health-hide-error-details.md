---
"secureflow": patch
---

`/api/health` no longer returns raw component error messages to anonymous callers. Prisma's messages include the database host and port, and ioredis's describe the client's retry settings. Monitors still get each component's status and latency. Signed-in users, including the `/dashboard/status` refresh, still see the messages.
