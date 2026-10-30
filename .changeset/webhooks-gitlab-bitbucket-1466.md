---
"secureflow": minor
---

feat(webhooks): add GitLab and Bitbucket webhook ingestion handlers (#1466)

- Implement `src/app/api/webhooks/gitlab/route.ts` with X-Gitlab-Token timing-safe validation
- Implement `src/app/api/webhooks/bitbucket/route.ts` with HMAC-SHA256 X-Hub-Signature verification
- Add `src/lib/webhooks/gitlab-verification.ts` with verification helpers (timing-safe token comparison, event type guards, safe log labels)
- Add `src/lib/webhooks/bitbucket-verification.ts` with HMAC helpers, signature parsing, and event routing
- Add unit tests for both verification libraries (47 tests across 2 files)
- Add integration route tests for both routes (19 tests across 2 files)
- Updated `docs/api.md` and `openapi.yaml` with full endpoint documentation
- New env vars: `GITLAB_WEBHOOK_TOKEN`, `BITBUCKET_WEBHOOK_SECRET`

