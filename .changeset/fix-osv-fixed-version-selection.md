---
"secureflow": patch
---

Recommend the fix for the release line a dependency is actually on. OSV advisories list one `fixed` version per maintained branch, and the first one was always reported, so `ws@8.16.0` was told to "update to 5.2.4 or higher" (a downgrade the installed version already satisfies). The fixed version is now chosen from the range containing the installed version, ignores `GIT` ranges whose `fixed` is a commit hash, and is never lower than the installed version.
