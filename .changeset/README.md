# Changesets

This folder is managed by `@changesets/cli`. Full documentation: https://changesets.dev

## Adding a changeset

From the repository root:

```bash
npx changeset
```

In the summary, mention anything that should stay visible across Docker image versions published by `.github/workflows/docker-publish.yml`:

- **New features**
- **Database migrations** — Prisma migration folder name and what it changes
- **AI flow updates** — file under `src/ai/flows/` and the behavior change

PRs that do not change runtime behavior do not need a changeset.

## Releasing (maintainers)

```bash
npx changeset version
```

This consumes pending changesets, bumps `package.json`, and updates `CHANGELOG.md`.
