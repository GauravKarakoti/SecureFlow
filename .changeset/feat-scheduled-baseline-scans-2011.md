---
"secureflow": minor
---

feat(scans): scheduled baseline scan of the default branch (#2011)

- Added opt-in scheduled baseline scanning for default branches in repositories.
- Implemented baseline file limit bounds (1-200, default 50) and frequency scheduling (daily, weekly, monthly).
- Distributed baseline scan jobs using fair queue scheduling across installations with concurrency limits.
- Tagged baseline findings with `BASELINE` and stored them under dedicated baseline container (`prNumber: 0`), preventing them from blocking PR checks.
- Added Baseline Findings dashboard tab and filterable queries in findings management.
- Added scheduled baseline settings section and manual "Run Baseline Scan Now" action in settings dashboard.
