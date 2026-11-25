---
"secureflow": minor
---

feat(gate): break-glass override label with required reason, expiry and audit entry (#2094)

- Implemented break-glass override evaluation in `src/lib/scanner/breakglass-override.ts`.
- Supports configurable label (e.g. `secureflow:override`, `security-override`).
- Verifies user authorization against configured `allowedRoles` (admin, maintainer, owner, write) and `allowedUsers`.
- Requires a comment with a justification / reason for the override.
- Automatically revokes the override when new commits are pushed or when the configured duration expires (defaults to 120 minutes).
- When active, the GitHub check-run passes with a prominent `OVERRIDDEN` banner and conclusion `success`.
- Adds an override banner to the PR comment and records an audit log entry in the database.
- Integrated into `gate-config.ts`, `check-run.ts`, and `scanEngine.ts`.
- Comprehensive unit tests in `src/lib/scanner/breakglass-override.test.ts`.
