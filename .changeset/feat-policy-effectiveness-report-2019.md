---
"secureflow": minor
---

feat(analytics): policy effectiveness report with hit counts and dismissal rate per policy (#2019)

- Added policy effectiveness analytics service calculating total findings, false positive share, resolved share, open count, and average resolution time over selectable evaluation periods (7d, 30d, 90d).
- Added classification thresholds: policies with >= 50% false-positive rate (minimum 3 findings) are flagged as `noisy`; policies with 0 findings in the period are marked as `inactive`.
- Added CSV export functionality with formula-injection mitigation by neutralizing cells starting with `=`, `+`, `-`, or `@`.
- Added authenticated API endpoints `/api/policies/effectiveness` and `/api/policies/effectiveness/export`.
- Added `PolicyEffectivenessCard` UI to the Policies dashboard with metric counters, period switching, status filters, search input, and direct CSV download.
