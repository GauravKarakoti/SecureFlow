---
"secureflow": minor
---

feat(webhook): admin 'Redeliver' action for stored deliveries in the diagnostics page (#2013)

- Added `redeliverWebhookDelivery` service executing `POST /app/hook/deliveries/{delivery_id}/attempts` using GitHub App credentials and JWT.
- Added `/api/admin/webhooks/[id]/redeliver` API route protected by admin session authorization.
- Added rate limiting (10 attempts per minute per admin) and audit logging (`WEBHOOK_REDELIVER` action in `AuditLog`).
- Added responsive 'Redeliver' button to delivery diagnostics page for eligible rejected, failed, or repository-disabled events.
- Handled errors gracefully including missing permissions, expired 3-day retention windows, and network failures.
