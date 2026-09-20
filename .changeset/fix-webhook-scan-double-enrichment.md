---
"secureflow": patch
---

Stop the webhook scan requesting every AI explanation twice. `processScanJob` explained each active finding, and the webhook worker then discarded those results and explained the same findings again before posting. The engine takes a new `enrich` option, and the worker passes `enrich: false`.
