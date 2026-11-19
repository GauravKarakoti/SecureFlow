---
"secureflow": minor
---

Support GitHub Enterprise Server through configurable API and web base URLs (#1809). Adds `GITHUB_API_URL` (defaulting to `https://api.github.com`) and `GITHUB_WEB_URL` (defaulting to `https://github.com` or custom instance origin), validates them with the typed environment schema, routes all Octokit and GitHub App client calls through the configured API base URL, ensures comments, notifications, and dashboard links use the configured web URL, rejects non-HTTPS URLs in production mode, and documents setup in `docs/setup.md`.
