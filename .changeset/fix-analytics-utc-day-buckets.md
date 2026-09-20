---
"secureflow": patch
---

Analytics charts now use UTC days throughout. The date range was built from the server's local midnight while rows were bucketed by their UTC date, so on a server east of UTC the range ended on the previous day and today's scans were missing from the daily, severity and velocity charts. Adds query-level tests for `scan-history.ts` (22% → 100% line coverage).
