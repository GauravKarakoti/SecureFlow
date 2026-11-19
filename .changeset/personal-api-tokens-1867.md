---
"secureflow": minor
---

Add Personal API Tokens with granular scopes, expiry, and last-used tracking (#1867). Users can generate named Bearer tokens (`sft_...`) with customizable expiry (30, 90 days, or custom date) and granular permissions (`findings:read`, `findings:write`, `scans:read`, `scans:write`, `policies:read`, `policies:write`, `audit:read`). Tokens are displayed once at creation and stored exclusively as SHA-256 hashes in PostgreSQL. API routes enforce required scopes (returning 403 on insufficient permissions) and validate token status (returning 401 on expired or revoked tokens). Successful requests record `lastUsedAt` and `lastUsedIp`, rate limiting is enforced per token, and token creation/revocation lifecycle events are captured in the tamper-evident audit log.
