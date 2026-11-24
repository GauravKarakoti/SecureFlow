---
"secureflow": minor
---

fix(github): handle primary and secondary GitHub API rate limits with throttling and retry-after (#2014)

- Integrated `@octokit/plugin-throttling` with handlers for GitHub primary and secondary API rate limits.
- Bounded retry-after delays with configurable maximums and automatic retries.
- Delayed and backed off queue jobs rather than moving them to DLQ on rate limits.
- Added GitHub API throttle metrics exposed in Prometheus (`secureflow_github_throttle_primary_total` and `secureflow_github_throttle_secondary_total`).
- Sanitized logged limit requests by redacting tokens, authorization headers, and excluding payloads.
