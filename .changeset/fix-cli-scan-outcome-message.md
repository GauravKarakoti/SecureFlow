---
"secureflow": patch
---

Report the findings that actually decided a CLI scan's exit code. The blocked message only counted HIGH/CRITICAL AI findings, so `--fail-on=LOW` could block on a LOW finding while announcing "0 secret-logging violations", and the advisory summary interpolated an unset threshold as `--fail-on=null`.
