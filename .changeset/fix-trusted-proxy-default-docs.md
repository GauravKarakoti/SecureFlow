---
"secureflow": patch
---

Correct the README after `TRUSTED_PROXY_HOP_COUNT` changed its default to `0` (it still said `1`, "the default" for Vercel), and log a one-time warning when forwarding headers arrive while neither `TRUSTED_PROXY_HOP_COUNT` nor `TRUSTED_PROXY_IPS` is set, because every client then shares one rate-limit bucket.
