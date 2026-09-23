---
"secureflow": patch
---

Add a `.prettierignore` so `format:check` skips generated output. Prettier only reads the root `.gitignore`, so the compiled CLI in `cli/dist` was being checked — which made `.husky/pre-commit` unpassable, since its `npm run secureflow` step needs the very directory its `format:check` step rejected.
