---
"secureflow": minor
---

feat(triage): [NSoC_2026] finding triage dismissal, stable fingerprinting, and scan-time suppression (#1702)

- Validate triage dismissal action with required category (`FALSE_POSITIVE`, `ACCEPTED_RISK`, `WONT_FIX`) and min 5 characters reason.
- Enforce deterministic content fingerprinting ignoring line numbers to maintain suppression across line shifts.
- Suppress dismissed findings in scan pipeline, preventing PR check blocks and excluding them from risk scores.
- Display suppressed findings count in PR comment report.
- Include end-to-end integration test coverage for all #1702 acceptance criteria.
