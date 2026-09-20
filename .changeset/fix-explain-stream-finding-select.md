---
"secureflow": patch
---

Fix `/api/findings/[id]/explain-stream` returning 500 for every request: the finding lookup selected fields that do not exist on the `Finding` model (`file`, `description`, `line`, `aiExplanation`), which Prisma rejects at runtime. The lookup now selects `fileLocation` and the owning user in one query, and again answers 404 for a missing finding and 403 for another user's finding.
