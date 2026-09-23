---
"secureflow": patch
---

Fix the CLI's Markdown report corrupting flagged source lines. A backtick in the line — a template literal, which is the common shape of a logged secret — closed the code span early and spilled the rest of the line into the table as prose, and backslashes were doubled inside a span whose contents render literally.
