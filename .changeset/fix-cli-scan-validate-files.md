---
"secureflow": patch
---

Validate each entry of `files` on `POST /api/cli/scan`, so a missing or non-string `path`/`content` returns 400 instead of a 500 or a scan of a nameless file.
