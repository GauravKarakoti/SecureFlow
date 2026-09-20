---
"secureflow": patch
---

`secureflow --local` no longer uploads staged files to the hosted SecureFlow API. The flag promised that no code leaves the machine, but it only set `LOCAL_AI_URL` in the CLI process. The CLI's AI pass is an HTTP upload to `/api/cli/scan`, so the code was still sent. Under `--local` that pass is now skipped; the local pattern scan still runs.
