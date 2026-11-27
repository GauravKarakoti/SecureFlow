---
"secureflow": patch
---

Fix the Docker build failing in the `deps` stage, where the root `postinstall` needed files that
stage never copies. The hook is now skipped there and `prisma generate` runs in `builder` as before (#2195).
