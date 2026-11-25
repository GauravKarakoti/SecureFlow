---
"secureflow": minor
---

feat(triage): structured dismissal reasons with reporting (#2096)

- Extended `DismissalReason` enum in `prisma/schema.prisma` and `src/lib/triage/statuses.ts` with structured categories: `TEST_CODE`, `MITIGATED_ELSEWHERE`, `ACCEPTED_RISK`, `FALSE_POSITIVE`, `WONT_FIX`, `UNSPECIFIED`.
- Enforced category requirement in `setFindingStatus` and `setFindingStatuses`: dismissals cannot be saved without a category.
- Provided `migrateUnspecifiedDismissals` to migrate existing legacy dismissals with missing reasons to the `UNSPECIFIED` category.
- Added dismissal analytics and aggregation service in `src/lib/triage/dismissal-report.ts` providing reporting by category and policy with exact counts and percentages.
- Displayed dismissal category badges in the Findings table (`findings-client.tsx`) and options in `finding-triage-controls.tsx`.
- Comprehensive unit tests covering validation, reporting, and migration in `src/lib/triage/dismissal-category.test.ts`.
