---
"secureflow": patch
---

Read `.secureflowignore` from the pull request's base branch instead of its head. The file decides which files the scanner skips (and the `[placeholders]` section which findings it drops), but it was fetched at the PR's own head commit, so a pull request that added a `.secureflowignore` containing `**` had every file in it, `.env` included, silently skipped and still received a passing check run. The base branch is the trust anchor, since changing it takes a merge through the repository's own review. If the base branch cannot be determined, or the file cannot be read, the scan runs without ignore rules, which can only cover more, never less. The webhook worker now passes `baseRef` and leaves ignore loading to the scan engine, so the webhook and `/api/findings` paths share one implementation.
