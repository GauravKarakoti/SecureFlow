---
"secureflow": patch
---

Fix the explain-stream endpoint crashing with a `ReferenceError` whenever a cached AI explanation is found, so cache hits now stream the cached result instead of failing the request.
