---
"secureflow": patch
---

Keep what the user typed in the findings search box when the debounced search is applied. The URL stores the trimmed term, and syncing the box back from it removed a trailing space, so pausing after "api " left "api" in the box before the next word. The debounce also no longer re-applies a term the URL already holds.
