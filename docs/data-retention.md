# Data Retention

> *"The Professor never keeps evidence longer than the plan needs it."*

SecureFlow scans other people's private code. This document states how long it
keeps what, why, and how to run the purge.

---

## Why this exists

Every table SecureFlow writes used to grow forever. `AuditLog`, `WebhookEvent`,
`ScanResult` and `Finding` had no purge path in normal operation — cascades only
fire when a `Repository` or `User` is deleted, which does not happen on a live
install.

The row that matters most is `Finding.codeSnippet`. It stores a verbatim excerpt
of a customer's source, taken from a pull request diff, retained indefinitely.
`maskSecrets()` scrubs the secret formats it recognises, but it is a regex
allowlist — anything it has no pattern for is stored in plaintext.

An unbounded permanent archive of other people's private code is a liability,
not a feature. Beyond that:

- There was no answer to "how long do you keep our code?" in a security review.
- GDPR storage limitation (Art. 5(1)(e)) expects a stated, bounded retention
  period. `AuditLog.userId` and `AuditLog.metadata` are personal data.
- Dashboard and leaderboard aggregates get slower every week they accumulate.

---

## The policy

| Data | Variable | Default | What happens |
| ---- | -------- | ------- | ------------ |
| Finding code snippets | `FINDING_SNIPPET_REDACT_DAYS` | 90 days | **Redacted**, row kept |
| Webhook delivery records | `WEBHOOK_EVENT_RETENTION_DAYS` | 30 days | Deleted |
| Scan results (and their findings) | `SCAN_RESULT_RETENTION_DAYS` | 180 days | Deleted |
| Audit log entries | `AUDIT_LOG_RETENTION_DAYS` | 365 days | Deleted |

### Why snippets are redacted, not deleted

This is the important half of the design. The snippet expires long before the
finding does, which decouples **how long we keep the evidence** from **how long
we keep your code**.

After 90 days a finding still records its type, severity, file location and
fingerprint — so trend data, triage decisions and the leaderboard all survive —
but `codeSnippet` is replaced with `[REDACTED — retention policy]`. Honouring a
short code-retention window therefore does not destroy the security history.

### What is never purged

**Findings whose triage status is still `OPEN`.** A finding a reviewer has not
finished with is live work, and the snippet is the thing they are looking at.
These are excluded from redaction by fingerprint until they are resolved or
dismissed.

### Why these numbers

- **Webhook events, 30 days.** The rows exist for delivery idempotency. GitHub
  does not redeliver beyond a few days, so a month is already generous.
- **Scan results, 180 days.** Scan history feeds the risk trend and the
  leaderboard; six months keeps those meaningful. Attached findings go with the
  scan via the existing `onDelete: Cascade`.
- **Audit log, 365 days.** Long enough for an annual compliance review, bounded
  enough to be a real answer.
- **Snippets, 90 days.** Long enough that a stale PR can still be reviewed with
  full context, short enough that the archive is not indefinite.

---

## Running the purge

```bash
npm run retention                      # dry run — reports, writes nothing
npm run retention -- --apply           # perform the purge
npm run retention -- --only=auditLog   # one target (repeatable)
npm run retention -- --batch-size=200  # smaller statements
npm run retention -- --help
```

**Dry run is the default.** This deletes production data; opting into that
should be an explicit act, not the consequence of forgetting a flag. Always run
without `--apply` first and read the report:

```
SecureFlow data retention — DRY RUN — nothing was written
Started 2026-08-16T12:00:00.000Z

  • findingSnippet (older than 90d, before 2026-05-18T…): would redact 500 row(s) (more remain — run again)
  • webhookEvent (older than 30d, before 2026-07-17T…): would delete 128 row(s)
  • scanResult (older than 180d, before 2026-02-17T…): would delete 0 row(s)
  • auditLog (older than 365d, before 2025-08-16T…): would delete 0 row(s)

Total affected: 628

Re-run with --apply to perform the purge.
```

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Success |
| `1` | One or more targets failed, or the run itself failed |
| `2` | Bad arguments or invalid retention configuration |

A failing target does not stop the others — one problematic table should not
prevent the rest from being cleaned up. The failure is reported per target and
reflected in the exit code.

### Batching

Deletions run in batches of 500 by default, capped at 200 batches per target per
run. A first run against a table that has been growing for a year will report
`more remain — run again` rather than taking a long lock or pulling the whole
table into memory. Run it repeatedly until it reports nothing remaining.

### Scheduling

Any cron-capable scheduler works. Daily, off-peak:

```cron
0 3 * * *  cd /app && npm run retention -- --apply >> /var/log/secureflow-retention.log 2>&1
```

As a GitHub Actions workflow, or a platform scheduled job, the shape is the
same: run the command, let the exit code decide whether to alert.

### Auditability

Every applied run writes an `AuditLog` row with `action = "RETENTION_PURGE"`
recording what it removed, so the purge is itself auditable. Dry runs do not —
a report of what *would* happen is not an event, and writing one would pollute
the table being purged.

---

## Configuration

Windows are read from the environment and **validated on load**. A variable that
is set but unusable throws rather than falling back to the default:

```
Retention configuration error: AUDIT_LOG_RETENTION_DAYS must be a whole number of days, got "forever".
```

Someone who tried to configure this and got it wrong should be told, not
silently given the default period. Accepted values are whole numbers between 1
and 3650 days.

An **unset** variable takes the default from the table above — that is the
normal case and is not an error.

---

## Handling an erasure request

To remove one user's data on request:

1. **Their repositories and everything under them** — deleting the `User` row
   cascades to `Repository` → `PullRequest` → `ScanResult` → `Finding`, and to
   `Account`, `Session`, `UserRole` and `UserPolicyToggle`.

   ```sql
   DELETE FROM "User" WHERE id = '<user-id>';
   ```

2. **Their audit log entries** — `AuditLog.userId` has no foreign key, so it is
   not covered by the cascade and must be handled explicitly. Prefer
   anonymisation over deletion when the entries are needed for security
   record-keeping:

   ```sql
   UPDATE "AuditLog" SET "userId" = NULL WHERE "userId" = '<user-id>';
   ```

3. **Their code snippets specifically**, without removing the account, can be
   redacted ahead of the normal window by temporarily lowering
   `FINDING_SNIPPET_REDACT_DAYS` and running `--only=findingSnippet --apply`.

Record the request and what was done — the purge job's own audit rows do not
cover a manual erasure.
