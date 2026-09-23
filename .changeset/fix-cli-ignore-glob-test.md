---
"secureflow": patch
---

Correct a `.secureflowignore` glob assertion that failed the Unit Tests job: `*.test.ts` does not match a file named `test.ts`, so `src/test.ts` must not be ignored.
