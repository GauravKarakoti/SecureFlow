---
"secureflow": patch
---

Authenticate PR manifest SBOM scanning as the GitHub App installation. It built its Octokit from `GITHUB_TOKEN`, a variable that is in no env schema and set nowhere, so the client was anonymous — manifests in private repositories 404ed and the scan silently found nothing.
