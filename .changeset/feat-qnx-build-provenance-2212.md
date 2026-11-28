---
"secureflow-cli": minor
---

Scans now check QNX 8.0 buildfiles, makefiles, scripts, CMake files and CI jobs for unpinned tool versions, missing target architectures and hardcoded credentials, with masked output. Adds a manual sample workflow and invalidates cached scan results through a new ruleset version (#2212).
