---
"secureflow": patch
---

Session roles are re-read from the database at least every five minutes. They were copied into the JWT at sign-in and only refreshed when missing or on an explicit `update()`, so demoting an admin (or deleting a user) had no effect on that user's existing session, which lasts a year. Every admin check reads `session.user.roles`.
