---
"secureflow": patch
---

Add scan/date and scan/severity/date Finding indexes for analytics windows and severity-bucket reads in migration 20261103070000_finding_analytics_indexes. Replace the redundant scan/severity index while preserving its equality prefix.
