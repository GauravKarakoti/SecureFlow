---
"secureflow": minor
---

Publish scan findings to GitHub Code Scanning via SARIF upload API (#1865). Adds a per-repository opt-in setting ("Publish findings to GitHub Code Scanning") in Settings (`/dashboard/settings`). Following a scan, findings are exported as SARIF v2.1.0 and uploaded to GitHub's code scanning API for the commit SHA and ref with stable tool name, rule IDs, and fingerprints to prevent duplicate alerts. Secret values and tokens are strictly sanitized using `maskFindingText` before upload. Missing permissions (`security_events: write`) or disabled Advanced Security are surfaced as actionable warnings on the repository card without failing the scan check run.
