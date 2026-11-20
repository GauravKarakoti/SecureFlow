---
"secureflow": minor
---

Add automated bundle size budgets, @next/bundle-analyzer, and Lighthouse CI quality gates (#1872).
- Added `@next/bundle-analyzer` integration opt-in via `ANALYZE=true` and `npm run analyze`.
- Configured per-route JavaScript bundle size budgets and growth thresholds in `bundle-budget.json`.
- Added `scripts/check-bundle-budgets.ts` to inspect Next.js build manifests and enforce budget thresholds in CI.
- Configured Lighthouse CI audits on authentication and dashboard pages in `lighthouse-budget.json` and `.lighthouserc.json`.
- Added `scripts/lighthouse-summary.ts` to output formatted audit results into GitHub Actions job summaries (`$GITHUB_STEP_SUMMARY`).
- Added budget adjustment policies and justification documentation in `CONTRIBUTING.md`.
