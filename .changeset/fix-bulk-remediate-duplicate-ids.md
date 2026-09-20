---
"secureflow": patch
---

Fix bulk remediation answering 403 when a finding id is repeated, and cap a request at 100 findings (one dashboard page), since each finding starts its own AI call.
