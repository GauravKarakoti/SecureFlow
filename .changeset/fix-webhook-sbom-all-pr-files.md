---
"secureflow": patch
---

Fix pull request SBOM scans missing manifests beyond the first 30 changed files: the webhook now pages through the PR's files, as the PR scan worker already does.
