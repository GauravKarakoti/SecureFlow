---
"secureflow": patch
---

Fall back to `llama-3.1-8b-instant` for the PR scan when `GROQ_MODEL` is not set. `GROQ_MODEL` is optional, but the scanner passed `process.env.GROQ_MODEL!` straight to Groq, so a deployment without it sent requests with no model and every scan failed.
