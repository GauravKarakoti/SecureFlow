---
"secureflow": patch
---

Read npm version specifiers properly when building the SBOM. Stripping one leading character turned `>=1.2.3` into `=1.2.3` and `latest` into `atest`; OSV matches no advisory against a malformed version, so those dependencies were reported clean. `<4.17.21` was dropped to `4.17.21` and queried as the installed version.
