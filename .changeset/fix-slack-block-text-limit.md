---
"secureflow": patch
---

Keep the Slack alert within Block Kit's 3,000-character section limit. Ten findings at the summary cap produced a ~4,000-character section, which Slack rejects as `invalid_blocks` — so the alert with the most findings was the one that never arrived.
