---
"secureflow-cli": minor
"secureflow": patch
---

feat(cli): project-specific custom regex rules with ReDoS protection

- Added support for defining custom regex security rules in `.secureflow.json` (`rules` / `customRules`) with unique `id`, `pattern`, `globs`, `severity`, and `message`.
- Added startup AST validation of custom rules reporting schema and syntax errors with line and column numbers.
- Integrated ReDoS and catastrophic backtracking protection using sandboxed VM execution with configurable timeouts (`timeoutMs`, default 100ms) and string length bounds.
- Added custom rule labeling across all terminal, SARIF, Markdown, HTML, and CSV exporters (`[Custom Rule: <id>]`).
- Evaluated custom rule findings against configured `--fail-on` gating thresholds.
- Documented two comprehensive examples (internal token format and banned APIs) in `README.md` and `cli/README.md`.
