---
"secureflow": patch
---

Read `/share/heist` links with the same parsers as the `/api/og/heist` preview card. The page and its metadata used the raw query, so `score=150` was described as 150 beside a card showing 100, `score=` was ranked D, and the title carried the uncapped, unsanitised project name. Repeated parameters now use their first value.
