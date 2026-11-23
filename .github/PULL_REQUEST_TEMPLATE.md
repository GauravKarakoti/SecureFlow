## Description

<!-- Briefly describe what you changed and why. -->

## Type of Change

- [ ] New feature
- [ ] Bug fix
- [ ] Documentation update
- [ ] Refactoring
- [ ] Performance improvement
- [ ] CI/CD changes
- [ ] Security fix

## What Changed

<!-- Bullet list of key changes. -->

-
-

## Motivation / Background

<!-- Why is this change needed? -->

## How to Test

<!-- Describe how you tested these changes. -->

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- Tests (if applicable):

## Screenshots (if applicable)

<!-- Add before/after screenshots or recordings. -->

## Related Issues

<!-- Link to related issues using #issue-number -->

closes #<!-- XXX -->

## Threat Model & Security Checklist

When modifying security-sensitive areas, consult [docs/threat-model.md](docs/threat-model.md) and update it if this PR:

- [ ] Alters ingress routes, API endpoints, webhook signature verification, or rate limits
- [ ] Changes background queues, worker locks, retry semantics, or concurrency boundaries
- [ ] Touches secret pre-screening, redaction masking, or prompt construction for LLM providers
- [ ] Changes `.secureflow.json`, `.secureflowignore`, or base-branch trust anchors
- [ ] Modifies outbound webhook dispatch, DNS pinning, IP blocklists, or SSRF defenses
- [ ] Affects tenant isolation, repository authorization, API scopes, RBAC, or audit logs
- [ ] If applicable, `docs/threat-model.md` has been updated with new mitigations or residual risks

## Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code where needed
- [ ] I have made corresponding changes to documentation (if needed)
- [ ] My changes generate no new warnings/errors
- [ ] I have added tests that prove my fix/feature works (if applicable)
- [ ] New and existing tests pass locally
- [ ] My commits follow the Conventional Commits format
- [ ] My branch is up-to-date with `main`
