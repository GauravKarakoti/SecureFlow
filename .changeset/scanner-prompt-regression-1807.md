---
"secureflow": minor
---

Add golden-file regression test suite for scanner prompts (#1807). Adds 12 code samples (positives and negatives covering hardcoded secrets, SQL injection, wildcard CORS, root containers, command injection, path traversal, and safe code) with recorded Groq LLM fixtures, CI unit tests running without network or real API keys, an opt-in live prompt regression runner (`npm run test:prompts:live`) with readable diff reporting and `--update` support, and updated documentation in CONTRIBUTING.md.
