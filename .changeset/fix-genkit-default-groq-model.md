---
"secureflow": patch
---

With `GROQ_MODEL` unset, the Genkit instance and the heist transmission now default to `openai/gpt-oss-20b`, the default documented in `genkit.ts`, instead of `llama-3.1-8b-instant`, which the same file notes Groq deprecated. `defaultModel` also no longer turns a blank `GROQ_MODEL` into `groq/`, or an already-namespaced id into `groq/groq/…`.
