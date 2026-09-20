---
"secureflow": patch
---

Restore dependency (SBOM) scanning of pull request manifests. #927 stopped the webhook route running `handlePullRequestSynchronize` inline so that the worker would own each delivery, but the worker never called it, so changed `package.json` / `requirements.txt` files were no longer scanned. The worker now runs it for `pull_request` `synchronize` deliveries, from `src/lib/sbom/pull-request-manifests.ts`.
