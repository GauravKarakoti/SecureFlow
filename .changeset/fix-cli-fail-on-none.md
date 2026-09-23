---
"secureflow": patch
---

Fix `--fail-on=NONE` in the CLI. It was accepted as a valid threshold but ranked below every severity, so instead of never blocking a commit it blocked on every finding — including LOW ones the default run ignores.
