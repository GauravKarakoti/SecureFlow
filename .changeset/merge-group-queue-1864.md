---
"secureflow": minor
---

Support GitHub Merge Queue by handling the `merge_group` webhook event (`checks_requested`). Automatically reports the required check run `SecureFlow Scan` on the merge group head SHA, reusing previous PR scan results when diff content is unchanged or executing a fast scan of the combined diff against the base-branch policy gate.
