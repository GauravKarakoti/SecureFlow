---
"secureflow-cli": minor
---

feat(cli): findings baseline file (.secureflow-baseline.json) and baseline management commands to suppress legacy violations (#2060)

- Added `cli/src/baseline.ts` engine implementing SHA-256 fingerprinting, snippet normalization, and line-shift resilience for legacy finding suppression.
- Added CLI subcommands `secureflow baseline create [path]` and `secureflow baseline update [path]`.
- Added `--baseline [path]` scan argument allowing developers and CI workflows to fail only on newly introduced security findings.
- Added SARIF v2.1.0 `baselineState` (`new`, `existing`, `absent`, `updated`) property integration and schema validation.
