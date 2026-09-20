---
"secureflow": patch
---

The security-explanation fallback chain now uses models Groq still serves (`openai/gpt-oss-120b`, `qwen/qwen3.6-27b`). All three previous fallbacks are shut down (`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on 2026-08-16, `mixtral-8x7b-32768` on 2025-03-20), so a rate-limited or timed-out primary model failed outright instead of failing over.
