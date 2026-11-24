---
"secureflow": patch
---

feat(pr): minimize outdated comments and delete-old-and-create sticky report on pushes (#2012)

- Added `replaceSecureFlowComment` and `deleteCommentSafely` to delete old SecureFlow comments before posting a clean new report comment.
- Added `minimizeOutdatedComment` using GitHub GraphQL `minimizeComment` mutation to mark stale comments as OUTDATED.
- Added `findAllSecureFlowComments` to reliably discover all historical comments across pagination.
- Added support for `replaceOldComments` option in `upsertSecureFlowComment`.
- Handled graceful fallback when old comments were deleted or when deletion API permissions are restricted.
