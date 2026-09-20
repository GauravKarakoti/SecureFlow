---
"secureflow": patch
---

Fix pull request SBOM scans reading manifests by branch name on the base repository, which skipped fork PRs (404) or scanned an unrelated base branch; manifests are now read at the PR's head commit.
