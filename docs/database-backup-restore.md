# Database Backup, Restore & Verification Guide (#1895)

SecureFlow stores all security scan results, vulnerability findings, policy rules, and audit logs in PostgreSQL. This guide provides self-hosters and operators with documented procedures for creating compressed database dumps, restoring backups, verifying backup integrity in ephemeral databases, and setting up automated scheduled backups via Linux `cron` or Kubernetes `CronJob`.

---

## 🛠️ CLI Tools Quick Reference

SecureFlow provides three built-in npm commands wrapping PostgreSQL's native utilities:

| Command | Utility Wrapped | Description |
| :--- | :--- | :--- |
| `npm run db:backup` | `pg_dump` | Creates a timestamped, compressed PostgreSQL archive (`-Fc`). |
| `npm run db:restore` | `pg_restore` / `psql` | Restores an archive into PostgreSQL. Refuses to overwrite non-empty databases without `--force`. |
| `npm run db:verify-backup` | `pg_restore` + `pg` | Restores a dump into an ephemeral temporary database, verifies table counts and Prisma migrations, and drops the temporary DB. |

---

## 🔒 Security & Credential Protection

All backup and restore commands follow strict data minimization principles:

- **No Passwords in Arguments**: Database passwords from `DATABASE_URL` are passed via the standard `PGPASSWORD` process environment variable, so credentials never appear in `ps aux` or process table inspections.
- **Zero Credentials in Logs**: Output and logs are scrubbed with `scrubCredentials()` to prevent connection strings or secrets from leaking into terminal scrollbacks or log aggregators.
- **Overwriting Guard**: `npm run db:restore` automatically inspects the target database and refuses to run if any existing tables are found, unless explicitly overridden with `--force`.

---

## 1. Creating Database Backups

### Basic Usage

To take an immediate backup using your active `DATABASE_URL` environment variable:

```bash
npm run db:backup
```

Backups are saved by default to the `backups/` directory with an ISO timestamp:
```text
======================================================
✅ SecureFlow Database Backup Created Successfully
======================================================
  File:     /opt/secureflow/backups/secureflow_backup_2026-11-20T23-45-00-000Z.dump
  Size:     14.28 MB (14973542 bytes)
  Database: secureflow
  Duration: 1820ms
  Format:   PostgreSQL Custom Compressed Archive (-Fc)
======================================================
```

### Custom Output File or Directory

```bash
# Save to custom directory
npm run db:backup -- --dir=/mnt/storage/secureflow-backups

# Save to specific file path
npm run db:backup -- --output=/var/backups/secureflow_pre_upgrade.dump
```

---

## 2. Restoring Database Backups

### Restoring into a Fresh / Empty Database

To restore the most recent backup into an empty database:

```bash
npm run db:restore
```

Or specify a specific backup archive:

```bash
npm run db:restore -- --file=backups/secureflow_backup_2026-11-20T23-45-00-000Z.dump
```

### Restoring into a Non-Empty Database (`--force`)

If the target database already contains tables, SecureFlow refuses to restore to prevent accidental data loss:

```text
❌ Restore failed: Target database "secureflow" is not empty (18 existing tables found: User, Repository, PullRequest...). Refusing to restore without --force flag.
```

To overwrite existing tables (dropping conflicting objects before recreating them), pass `--force`:

```bash
npm run db:restore -- --file=backups/secureflow_backup_2026-11-20T23-45-00-000Z.dump --force
```

---

## 3. Verifying Backup Integrity (`npm run db:verify-backup`)

> *"An untested backup is not a backup."*

`npm run db:verify-backup` provides automated recovery validation without impacting your production database:

1. Connects to PostgreSQL and creates an ephemeral temporary database (e.g. `sf_verify_1732146300_ab12`).
2. Restores the backup archive into the temporary database.
3. Inspects `information_schema.tables` to verify that core application tables (`User`, `Repository`, `PullRequest`, `ScanResult`, `Finding`, `Policy`) exist.
4. Queries `_prisma_migrations` to ensure that all database migrations applied cleanly and none are marked rolled back.
5. Automatically drops the ephemeral temporary database.

### Running Verification

```bash
# Verify the newest backup in backups/
npm run db:verify-backup

# Verify a specific backup archive
npm run db:verify-backup -- --file=backups/secureflow_backup_2026-11-20T23-45-00-000Z.dump
```

Expected output:
```text
======================================================
✅ SecureFlow Backup Verification PASSED
======================================================
  Backup:     /opt/secureflow/backups/secureflow_backup_2026-11-20T23-45-00-000Z.dump
  Ephemeral:  sf_verify_1732146300_ab12 (dropped after verification)
  Tables:     21 tables verified
  Migrations: 16 Prisma migrations valid
  Duration:   2340ms
======================================================
```

---

## 4. Automated Scheduling

### Option A: Linux `cron`

Configure a crontab on your host or VM using `crontab -e`:

```bash
# 1. Daily backup at 02:00 UTC
0 2 * * * cd /opt/secureflow && npm run db:backup >> /var/log/secureflow-backup.log 2>&1

# 2. Prune backups older than 30 days daily at 02:30 UTC
30 2 * * * find /opt/secureflow/backups -type f -name "*.dump" -mtime +30 -delete

# 3. Weekly automated restore verification every Sunday at 04:00 UTC
0 4 * * 0 cd /opt/secureflow && npm run db:verify-backup >> /var/log/secureflow-verify.log 2>&1
```

### Option B: Kubernetes `CronJob`

For Kubernetes deployments (including Helm installations), deploy this native `CronJob` manifest:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: secureflow-db-backup
  namespace: secureflow
  labels:
    app.kubernetes.io/name: secureflow
    app.kubernetes.io/component: backup
spec:
  # Run daily at 02:00 UTC
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app.kubernetes.io/name: secureflow
            app.kubernetes.io/component: backup
        spec:
          restartPolicy: OnFailure
          securityContext:
            runAsNonRoot: true
            runAsUser: 1001
            fsGroup: 1001
          containers:
            - name: backup
              image: ghcr.io/gauravkarakoti/secureflow:latest
              command: ["npm", "run", "db:backup"]
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: secureflow-secrets
                      key: database-url
              volumeMounts:
                - name: backup-storage
                  mountPath: /app/backups
          volumes:
            - name: backup-storage
              persistentVolumeClaim:
                claimName: secureflow-backup-pvc
```

---

## 5. Retention Strategy Advice

A resilient backup retention policy protects against both immediate operational outages and delayed discovery of data corruption:

| Frequency | Retention Period | Rationale |
| :--- | :--- | :--- |
| **Daily Backups** | 7 to 14 days | Rapid recovery from accidental deletions, bad deployments, or system failures. |
| **Weekly Snapshots** | 4 to 8 weeks | Rollback window for issues discovered days after a release. |
| **Monthly Archives** | 12 months | Compliance, long-term security auditing, and forensic analysis. |

### Retention Pruning Script Example

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/secureflow/backups"

# Remove daily backups older than 14 days
find "$BACKUP_DIR" -type f -name "secureflow_backup_*.dump" -mtime +14 -delete
```
