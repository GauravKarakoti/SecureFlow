---
"secureflow": minor
---

Automatically mark findings as resolved when a later push removes them (#1869). After each completed full scan of a pull request, compares new finding fingerprints with open findings from earlier scans of the same pull request. Findings whose fingerprint is no longer detected are marked as `RESOLVED`, recording the resolving commit SHA, timestamp, and audit trail. Dismissed findings maintain their dismissed status, and failed or partial scans never resolve findings. The dashboard displays "resolved by commit <sha>" on finding badges and cards, and average resolution time is computed and surfaced in the analytics dashboard.
