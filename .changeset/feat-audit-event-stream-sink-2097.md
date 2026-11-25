---
"secureflow": minor
---

feat(audit): stream audit log events to S3-compatible storage or syslog (#2097)

- Added audit event streaming module in `src/lib/audit/audit-sink.ts` supporting S3-compatible object storage (Backblaze B2, AWS S3, MinIO) and Syslog over TLS.
- Sanitizes streamed events to strictly prevent code snippets, secret tokens, or credentials from appearing in payloads.
- Signs batches with SHA-256 batch manifests containing sequence numbers, event hashes, and cryptographic signatures.
- Includes exponential backoff retries with local buffer memory protection (`bufferLimit`).
- Designed to be completely asynchronous and non-blocking: failing sinks never block PR scans or user transactions.
- Added Cloudflare CDN Worker in `workers/audit-cdn-worker.js` to cache audit read operations and eliminate S3 rate limit bottlenecks via Bandwidth Alliance.
- Added comprehensive setup guide in `docs/audit-stream-backblaze-cloudflare-setup.md`.
- Added sink health metrics to `getAuditLogMetrics` and `getAuditSinkHealth` in `src/lib/actions/admin.ts`.
- Comprehensive test coverage with fake sink and failure simulation in `src/lib/audit/audit-sink.test.ts`.
