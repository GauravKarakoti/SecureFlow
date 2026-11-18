---
"secureflow": minor
"secureflow-cli": minor
---

Support reasons and expiry dates for `.secureflowignore` entries (#1811). Allows ignore patterns to specify an optional `reason` and optional `expires` date (via bracket syntax `[expires=YYYY-MM-DD]: <reason>`, comment syntax, colon separator, or JSON entries) while maintaining backward compatibility with plain patterns. Expired entries are no longer applied and are reported in the pull request comment so they can be reviewed. Entries without reasons emit a scan log warning, and invalid dates are reported safely without crashing the scan.
