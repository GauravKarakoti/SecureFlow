---
"secureflow-cli": minor
---

Add `--since REF` option to scan only files changed versus a git reference (e.g. `--since origin/main`). Includes added, copied, modified, and renamed files while skipping deleted files, and fails with clear user guidance when outside a git repository or when the specified git ref does not exist.
