---
"secureflow": patch
---

Prefix `GROQ_MODEL` with the `groq/` namespace before handing it to Genkit. The documented value (`GROQ_MODEL=openai/gpt-oss-20b`) is a bare Groq id, which Genkit rejects with `NOT_FOUND`, so the heist message stream and the first model of the security-explanation fallback chain failed whenever `GROQ_MODEL` was set.
