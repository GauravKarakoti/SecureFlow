---
"secureflow-cli": patch
---

Fix `scan --staged` saving the diff-filtered result into the scan cache, which made a later full scan
miss older violations in the same file. Entries already written this way can be removed with
`secureflow cache-clear` (#2194).
