---
"secureflow": patch
---

Restore Core CI. Five type errors in the CLI's SARIF validator failed `npm ci` repo-wide — `cli`'s `prepare` script runs `tsc` — so every job on `main` and on every open pull request stopped at "Install dependencies". Also fixes a `prefer-const` lint error in the `.secureflowignore` compiler.
