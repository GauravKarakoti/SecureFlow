---
"secureflow": patch
---

Fix local-model mode (`LOCAL_AI_URL`). `local-model.ts` imported a named `openAI` from `@genkit-ai/compat-oai`, which the package does not export, so building the local Genkit instance threw `openAI is not a function`. It now uses `openAICompatible` with the configured `baseURL`. This also clears the `npx tsc --noEmit` failure on `main`.
