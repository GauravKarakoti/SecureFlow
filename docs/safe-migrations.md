# Safe Database Migrations Guide

## Overview

Database migrations in production require extreme care. Unsafe DDL operations such as dropping tables, dropping columns, altering column types directly, or renaming tables/columns can cause immediate outages, locks, or irreversible data loss during rolling deployments.

SecureFlow enforces automated migration safety checks in CI (`npm run db:check-migration-safety`).

---

## 🚫 Destructive Operations Detected

The migration safety checker flags the following operations as destructive:

1. **`DROP TABLE ...`**
   - Data loss risk: Permanently deletes table data.
2. **`DROP COLUMN ...`**
   - Data loss risk: Permanently removes column data.
3. **`ALTER COLUMN ... TYPE ...`** / `ALTER TABLE ... ALTER COLUMN ... [SET DATA] TYPE ...`
   - Data loss / downtime risk: May rewrite the table, acquire exclusive table locks, or fail when casting values.
4. **Renames (`RENAME COLUMN ... TO ...`, `RENAME TO ...`)**
   - Downtime risk: Breaks running application instances that still reference the old name during rolling updates.

---

## 🔄 The Expand-and-Contract Pattern

Rather than performing destructive schema changes in a single migration, use the **Expand-and-Contract** (or Parallel Run) pattern across multiple releases:

```
┌──────────────────────────────────────────────────────────┐
│ Step 1: Expand                                           │
│ Add the new column/table as optional or with default.   │
│ Keep the old column intact.                              │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2: Dual-Write / Migrate Data                        │
│ Update application code to write to both old and new.    │
│ Backfill historical data in background.                 │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3: Switch Reads                                     │
│ Update application code to read only from the new column.│
│ Old column is now completely unreferenced by code.      │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Step 4: Contract                                         │
│ Safe to drop the old column/table. Mark migration with:  │
│ -- @secureflow-allow-destructive: <Reason>               │
└──────────────────────────────────────────────────────────┘
```

---

## ✍️ How to Approve an Intentional Destructive Migration

If a destructive migration is genuinely intentional and safe (for example, deprecation after contract phase, scratch tables, or local development cleanup), you must include an explicit approved marker comment with a reason inside the migration SQL file:

```sql
-- @secureflow-allow-destructive: Dropping deprecated legacy_status column after expand-and-contract phase 3 completion.
ALTER TABLE "Finding" DROP COLUMN "legacy_status";
```

Acceptable comment marker formats:

- `-- @secureflow-allow-destructive: <reason>`
- `-- @allow-destructive: <reason>`
- `/* @secureflow-allow-destructive: <reason> */`
- `/* @allow-destructive: <reason> */`

The reason must be non-empty and explain why the change is safe. Without this marker, CI will block the pull request.
