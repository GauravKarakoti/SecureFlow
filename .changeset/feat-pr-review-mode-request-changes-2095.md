---
"secureflow": minor
---

feat(pr): optional PR review mode that requests changes when a scan is blocked (#2095)

- Added opt-in pull request review mode in `src/lib/github/pull-request-review.ts`.
- Submits a pull request review with `REQUEST_CHANGES` when the scan verdict is blocked in opt-in repositories.
- Dismisses previous `CHANGES_REQUESTED` review(s) when the next scan passes.
- Guaranteed never to submit an automatic `APPROVE` review under any circumstances.
- Handles missing GitHub permissions or API failures gracefully with a logged warning, preventing scan job failures.
- Supported configuration in `.secureflow.json` under `pullRequestReview`.
- Integrated with `gate-config.ts` and `scanEngine.ts`.
- Comprehensive unit tests in `src/lib/github/pull-request-review.test.ts`.
