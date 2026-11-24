---
"secureflow": patch
---

ci(security): harden SecureFlow's GitHub Actions workflows with SHA pinning, least privilege, actionlint, and zizmor (#2017)

- Pinned every third-party GitHub action to immutable 40-character commit SHAs with semantic version comments across all 13 workflows.
- Enforced top-level `permissions: contents: read` across all workflow files and restricted write permissions strictly to the jobs that require them.
- Added `actionlint` and `zizmor` lint jobs to the Core CI pipeline to enforce workflow correctness and security best practices on pull requests and pushes.
- Fixed CodeQL initialization inputs and sanitized script inputs to prevent template injection vulnerabilities.
- Added `persist-credentials: false` to checkouts to safeguard GitHub Actions tokens.
