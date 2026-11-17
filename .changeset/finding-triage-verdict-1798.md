---
"secureflow": minor
---

Refresh the latest scanned PR verdict and existing SecureFlow check after a repository owner suppresses or reopens a finding. Store scan context in Prisma migration `20261117084000_finding_triage_scan_context`, allow optional notes with a required dismissal category, and preserve suppression across rescans.
