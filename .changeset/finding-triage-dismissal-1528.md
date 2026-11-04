---
"secureflow": minor
---

Finding Triage & Dismissal (#1528):

- Added `DISMISSED` triage status with dismissal reason categories (`FALSE_POSITIVE`, `ACCEPTED_RISK`, `WONT_FIX`).
- Enforced required reason notes on dismissal actions.
- Supported stable fingerprint-based scan-time suppression so dismissed findings do not block pull requests or Check Runs.
- Added previously dismissed findings reporting in pull request comment summaries.
- Recorded full audit trail in Vault Logs with actor, finding, dismissal reason, note, and timestamp.
- Added dashboard triage controls for dismissing and reopening findings.
