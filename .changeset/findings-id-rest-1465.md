---
"secureflow": minor
---

feat(api): add base REST handler for single finding at /api/findings/[id] (#1465)

- Implement GET (fetch full finding detail with ownership check), PATCH (update triage status/severity), and DELETE (permanent removal with audit log)
- All operations scope to the authenticated session user via the relation chain to prevent IDOR attacks
- Dual-tier rate limiting: IP-based outer guard + per-user inner guard
- New route test file with 17 test cases covering auth, ownership, validation, rate limiting, and success paths
- Updated `docs/api.md` and `openapi.yaml` with full endpoint documentation
