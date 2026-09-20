---
"secureflow": patch
---

The Groq SDK callers (PR scan, streamed explanations, prompt-injection classifier) now default to `openai/gpt-oss-20b` when `GROQ_MODEL` is unset, instead of `llama-3.1-8b-instant`, which Groq shut down on 2026-08-16. `docs/setup.md` and the README recommended the same retired model.
