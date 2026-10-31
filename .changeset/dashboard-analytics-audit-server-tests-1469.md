---
"secureflow": patch
---

test(dashboard): add server page unit tests for Analytics and Audit routes (#1469)

- Add `src/app/dashboard/analytics/page.test.tsx` testing server-side session authentication guards, query param range parsing (7, 30, 90 days), data aggregation prop forwarding to `AnalyticsClient`, and empty state handling
- Add `src/app/dashboard/audit/page.test.tsx` testing session auth redirection, Prisma parallel counts for monitored repositories and recent system actions, user display name fallbacks, and prop passing to `AuditLogTable`
