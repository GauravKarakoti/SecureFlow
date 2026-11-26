---
"secureflow": minor
---

Add CI migration safety check (`npm run db:check-migration-safety`) that scans new migration SQL for destructive operations (`DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN ... TYPE`, renames) and requires an explicit approved marker comment with a reason, along with safe migration guidance and expand-and-contract documentation in CONTRIBUTING (#2104).
