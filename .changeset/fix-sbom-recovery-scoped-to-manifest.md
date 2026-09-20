---
"secureflow": patch
---

When a completed SBOM job is retried and its result has to be rebuilt from the database, only that manifest's dependency findings are used. The rebuild used to take the pull request's latest `ScanResult` whole, which could be the code scan or another manifest's scan. It also split scoped npm names (`@scope/pkg@1.0.0`) at the wrong `@`. A clean completed scan is now recovered from its ScanJob row instead of failing as unrecoverable.
