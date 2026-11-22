# 🤝 Contributing to SecureFlow

<div align="center">

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/pulls)
[![Contributors](https://img.shields.io/github/contributors/GauravKarakoti/SecureFlow?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/graphs/contributors)
[![GitHub issues](https://img.shields.io/github/issues/GauravKarakoti/SecureFlow?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/GauravKarakoti/SecureFlow?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/pulls)

</div>

> **First off, thank you for considering contributing to SecureFlow!**  
> It's people like you that make open-source security tools reliable and accessible. This document is a complete, self-contained guide with everything you need to set up the project, run tests, understand issue difficulty labels, and submit high-quality pull requests.

---

## 📋 Table of Contents

- [📜 Code of Conduct](#-code-of-conduct)
- [🎯 Issue Difficulty Labels (level1, level2, level3)](#-issue-difficulty-labels-level1-level2-level3)
  - [Difficulty Comparison Matrix](#difficulty-comparison-matrix)
  - [🟢 level1 (Beginner / Good First Issue)](#-level1-beginner--good-first-issue)
  - [🟡 level2 (Intermediate / Feature Enhancement)](#-level2-intermediate--feature-enhancement)
  - [🔴 level3 (Advanced / Architectural Work)](#-level3-advanced--architectural-work)
- [🚀 Tech Stack](#-tech-stack)
- [💻 Prerequisites & 2-Minute Quickstart](#-prerequisites--2-minute-quickstart)
  - [System Prerequisites](#system-prerequisites)
  - [Quickstart: Clone, Install & Run Tests](#quickstart-clone-install--run-tests)
- [⚡ Running the Project](#-running-the-project)
  - [1. Running & Testing the CLI (`secureflow`)](#1-running--testing-the-cli-secureflow)
  - [2. Running the Mission Control Dashboard](#2-running-the-mission-control-dashboard)
    - [Option A: Mock Mode (Zero External Credentials)](#option-a-mock-mode-zero-external-credentials--recommended-for-ui-work)
    - [Option B: Docker Compose (PostgreSQL + Redis)](#option-b-docker-compose-postgresql--redis)
    - [Option C: Local PostgreSQL or Cloud Database](#option-c-local-postgresql-or-cloud-database)
  - [3. Running Background Queue Workers](#3-running-background-queue-workers)
- [🧪 Testing Guidelines & Suites](#-testing-guidelines--suites)
- [📁 Branch Naming Conventions](#-branch-naming-conventions)
- [📝 Commit Guidelines (Conventional Commits)](#-commit-guidelines-conventional-commits)
- [🔄 Contribution Lifecycle & Issue Workflow](#-contribution-lifecycle--issue-workflow)
- [✅ Pull Request Process & Complete Checklist](#-pull-request-process--complete-checklist)
  - [PR Verification Commands](#pr-verification-commands)
  - [PR Description Template](#pr-description-template)
  - [Interactive Checklist](#interactive-checklist)
- [💻 Coding Standards](#-coding-standards)
- [📚 Documentation Standards](#-documentation-standards)
- [📦 Changelog (Changesets)](#-changelog-changesets)
- [📁 Folder Structure Explained](#-folder-structure-explained)
- [💡 Tips for First-Time Contributors](#-tips-for-first-time-contributors)
- [❓ FAQ for Contributors](#-faq-for-contributors)
- [🙏 Thank You](#-thank-you)

---

## 📜 Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. We expect all contributors to:

- Be respectful, constructive, and welcoming to all community members.
- Provide clear, actionable feedback during discussions and code reviews.
- Focus on what is best for the security and usability of the project.
- Show empathy and patience toward fellow contributors of all experience levels.

---

## 🎯 Issue Difficulty Labels (level1, level2, level3)

SecureFlow categorizes open issues with difficulty labels to help you find tasks suited to your experience level and time commitment:

### Difficulty Comparison Matrix

| Label        | Target Contributor                      | Scope & Complexity                                                                | Typical Files Touched    | Expected Knowledge                                                   | Real SecureFlow Examples                                                                       |
| :----------- | :-------------------------------------- | :-------------------------------------------------------------------------------- | :----------------------- | :------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **`level1`** | New contributors, students, quick fixes | Small, isolated bug fixes, documentation, styling, accessibility                  | 1–2 files                | Basic TypeScript/React, Git, Vitest                                  | Badge contrast ratios, `--no-color` CLI support, snapshot tests, documentation links           |
| **`level2`** | Experienced contributors                | Feature enhancements, CLI flags/subcommands, UI components, state sync            | 3–6 files                | Next.js App Router, Tailwind, Node.js CLI, Prisma schema             | `secureflow init` command, `--since REF` diff scan, Dark mode toggle, side-by-side code viewer |
| **`level3`** | Core contributors, security engineers   | Architectural changes, core scanning algorithms, queue workers, LLM orchestration | 7+ files / cross-cutting | Concurrency, BullMQ, Genkit/Groq LLMs, Cryptography, k6 load testing | Configurable AI model providers, DLQ auto-retries, HMAC audit trail chain, k6 load testing     |

---

### 🟢 `level1` (Beginner / Good First Issue)

**What it means:**

- Self-contained and isolated tasks with clear specifications.
- Requires modifying or creating only 1 or 2 files.
- No complex state management, database migrations, or distributed architecture.
- Perfect for getting comfortable with the codebase, development setup, and PR workflow.

**Concrete Examples:**

1. **Accessibility & Contrast Enhancements**:
   - _Example_: Adjusting badge contrast ratios in `src/lib/severity-theme.ts` to satisfy WCAG AA (4.5:1 ratio) and adding `aria-label` / `role="status"` attributes to `src/components/ui/severity-badge.tsx`.
2. **CLI Output Formatting & Standard Conventions**:
   - _Example_: Supporting the `NO_COLOR` standard and `--no-color` flag in `cli/src/lib/tui.ts` to disable ANSI escape sequences when piping output to files or CI viewers.
3. **Snapshot & Unit Tests**:
   - _Example_: Adding snapshot tests in `cli/src/lib/tui.snapshot.test.ts` to prevent terminal UI layout regressions on tables and summary banners.
4. **Documentation & Typos**:
   - _Example_: Fixing broken documentation links, clarifying prerequisites in guides, or updating JSDoc comments on utility functions.

---

### 🟡 `level2` (Intermediate / Feature Enhancement)

**What it means:**

- Multi-component features or user-facing enhancements across the web dashboard or CLI.
- Touches 3 to 6 files across components, routes, and tests.
- Involves state management, CLI argument parsing, URL query parameter synchronization, or database schema additions.
- Requires understanding how multiple modules interact.

**Concrete Examples:**

1. **Interactive CLI Initialization (`secureflow init`)**:
   - _Example_: Adding `cli/src/config.ts` and wiring `secureflow init` in `cli/src/index.ts` to prompt users for scan paths, fail-on thresholds, and AI remediation, writing a commented `.secureflowrc.json`, while supporting `--yes` and `--force`.
2. **Git Diff Scanning (`--since REF`)**:
   - _Example_: Adding `--since <ref>` in `cli/src/git.ts` and `cli/src/index.ts` to scan only added, modified, and renamed files compared to a branch (e.g. `origin/main`), skipping deleted files, and handling non-git directories gracefully.
3. **Dark / Light / System Theme Toggle**:
   - _Example_: Creating `src/components/theme-toggle.tsx`, persisting preference in `localStorage`, handling system preference changes, and preventing flashes of unstyled content in `src/app/layout.tsx`.
4. **Side-by-Side Code Context & Remediation Viewer**:
   - _Example_: Building `src/components/findings/code-context-viewer.tsx` and the dedicated `/dashboard/findings/[id]` route to display vulnerable code lines alongside AI-suggested fixes with one-click copy buttons.
5. **Findings Table Filter & URL State Synchronization**:
   - _Example_: Updating `src/components/findings/findings-table.tsx` to keep search text, severity filter dropdowns, and pagination in sync with browser URL search parameters and the browser history.

---

### 🔴 `level3` (Advanced / Architectural Work)

**What it means:**

- Deep architectural changes, performance optimizations, or mission-critical security features.
- Cross-cutting impact touching core scanning engines, asynchronous BullMQ workers, LLM orchestration, or cryptographic guarantees.
- Requires advanced understanding of concurrency, failure modes, dead-letter queues, streaming responses, or distributed caching.

**Concrete Examples:**

1. **Configurable AI Provider & Model Engine**:
   - _Example_: Abstracting remediation and explanation flows in `src/ai/model-config.ts` to allow switching between Groq, Ollama, vLLM, and OpenAI via `AI_PROVIDER`, `AI_MODEL`, and `AI_BASE_URL` with startup validation and fallback chains.
2. **BullMQ Worker Queue Resiliency & DLQ Auto-Retries**:
   - _Example_: Designing dead-letter queue (DLQ) retry strategies in `src/lib/queue/worker.ts` and `src/lib/queue/dlq-auto-retry.ts` with exponential backoff and job state transitions.
3. **Cryptographic Audit Trail Verification**:
   - _Example_: Implementing HMAC-SHA256 signature chains in `src/lib/security/hmacSigner.ts` and `scripts/verify-audit-chain.ts` to detect tampering or missing entries in the immutable security audit log.
4. **High-Concurrency Webhook Load Testing**:
   - _Example_: Authoring Grafana k6 performance scenarios in `load-tests/webhook.k6.js` that generate synthetic HMAC-signed GitHub webhook payloads to evaluate rate-limiting thresholds and worker pool saturation.

---

## 🚀 Tech Stack

Before diving in, take a moment to review our primary stack:

- **Web Application**: Next.js 16 (App Router), React 19, TypeScript
- **Styling & Components**: Tailwind CSS, Radix UI primitives, Lucide React
- **CLI**: Node.js CLI workspace (`cli/`), TypeScript, Zod, Model Context Protocol (MCP) SDK
- **Database & Cache**: PostgreSQL with Prisma ORM, Redis (Upstash / ioredis)
- **Background Jobs**: BullMQ distributed task queues
- **Testing**: Vitest (Unit & Integration), Playwright (E2E & Accessibility with `@axe-core/playwright`), k6 (Load Testing)
- **AI & LLM**: Groq SDK (`openai/gpt-oss-20b`), Genkit AI flows, ElevenLabs (Audio debriefs)
- **Security & Linters**: ESLint, Prettier, Spectral (OpenAPI), Changesets

> 📖 **Architecture Deep Dive**: For complete visual diagrams tracing webhook receipt, BullMQ queues, scanning pipelines, policy evaluation, and check runs, see **[docs/architecture.md](./docs/architecture.md)**.

---

## 💻 Prerequisites & 2-Minute Quickstart

A new contributor can clone the repository, install dependencies, and run all unit and integration tests **using only this guide**, without needing any cloud credentials, API keys, or running databases.

### System Prerequisites

Make sure the following tools are installed on your machine:

| Requirement             | Minimum Version   | Recommended | Notes                                              |
| :---------------------- | :---------------- | :---------- | :------------------------------------------------- |
| **Node.js**             | `>= 20.0.0`       | `22.x`      | Check `.nvmrc` (`nvm use` or `fnm use`)            |
| **npm**                 | `>= 10.0.0`       | Latest      | Comes bundled with Node.js                         |
| **Git**                 | `>= 2.30.0`       | Latest      | Required for CLI git diffing features              |
| **Docker** _(Optional)_ | Docker Compose v2 | Latest      | Only needed if running full Postgres/Redis locally |

### Quickstart: Clone, Install & Run Tests

```bash
# 1. Clone your fork locally
git clone https://github.com/YOUR_USERNAME/SecureFlow.git
cd SecureFlow

# 2. Install workspace dependencies
npm install

# 3. Create a local environment file
cp .env.example .env

# 4. Run the test suite immediately
npm test
```

> 💡 **Why `npm test` works out of the box**:  
> The test runner automatically sets `GROQ_API_KEY=test-key` and uses mock adapters for the database, GitHub App, and Redis. You do **not** need to sign up for Groq, GitHub Developer accounts, or run a local database just to run tests or work on features!

---

## ⚡ Running the Project

### 1. Running & Testing the CLI (`secureflow`)

The SecureFlow CLI lives in the `cli/` workspace and provides developer-facing pre-commit scanning, SBOM inspection, and threat intelligence MCP tooling.

#### Building the CLI

```bash
# Compile CLI TypeScript code into cli/dist/
npm run cli:build
```

#### Running CLI Commands

Once built, you can run the CLI via `npx secureflow` from anywhere in the repository:

```bash
# View all CLI commands and available options
npx secureflow --help

# Initialize a .secureflowrc.json configuration file
npx secureflow init

# Initialize with defaults non-interactively (useful for CI scripts)
npx secureflow init --yes

# Scan staged git files for hardcoded secrets and security violations
npx secureflow scan

# Scan only files added, modified, or renamed compared to a git branch
npx secureflow scan --since origin/main

# Scan with plain-text output (disables ANSI colors)
npx secureflow scan --no-color

# Export findings in machine-readable SARIF or JSON formats
npx secureflow scan --format sarif -o results.sarif
npx secureflow scan --format json -o results.json

# Analyze software bill of materials (SBOM) manifests for CVEs
npx secureflow sbom package.json
```

#### Running CLI Unit & Integration Tests

```bash
# Run the complete CLI test suite (700+ tests including parser, ignore, and diff tests)
npm run cli:test

# Run TypeScript type check on CLI source
npm run cli:typecheck
```

---

### 2. Running the Mission Control Dashboard

You have three flexible options for running the web dashboard locally depending on your task:

#### Option A: Mock Mode (Zero External Credentials — Recommended for UI Work)

If you are working on dashboard UI, components, navigation, finding views, or themes, you do not need real cloud accounts. Enable mock mode in your `.env`:

```env
NEXT_PUBLIC_MOCK_AUTH=true
ALLOW_MOCK_AUTH=true
```

Then start the development server:

```bash
npm run dev
```

Open [http://localhost:9002](http://localhost:9002) in your browser. You can log in with one click via Mock Auth and interact with mock findings, policies, and audit logs.

#### Option B: Docker Compose (PostgreSQL + Redis)

If you want a complete local environment with a real database and cache:

```bash
# 1. Start PostgreSQL and Redis containers in the background
docker compose up -d db redis

# 2. Generate Prisma client & apply database migrations
npm run db:gen
npm run db:migrate
npm run db:seed

# 3. Start the Next.js development server
npm run dev
```

#### Option C: Local PostgreSQL or Cloud Database

If you prefer running PostgreSQL natively or via Neon:

1. Configure `DATABASE_URL` and `DATABASE_POOL_URL` in `.env`.
2. Run database setup:
   ```bash
   npm run db:gen
   npm run db:migrate
   npm run db:seed
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```

---

### 3. Running Background Queue Workers

SecureFlow offloads heavy scans, SBOM queries, and webhook events to BullMQ workers.

To start the background worker process in a separate terminal:

```bash
npm run worker
```

---

## 🧪 Testing Guidelines & Suites

We prioritize deterministic, fast, and comprehensive testing. Always ensure relevant suites pass before opening a PR:

| Command                       | Scope                | Description                                                                  |
| :---------------------------- | :------------------- | :--------------------------------------------------------------------------- |
| `npm test`                    | Unit & Integration   | Runs all root and workspace unit tests via Vitest                            |
| `npm run cli:test`            | CLI Workspace        | Runs all 700+ CLI parser, argument, and diff integration tests               |
| `npm run typecheck`           | TypeScript           | Verifies root and dashboard types with `tsc --noEmit`                        |
| `npm run cli:typecheck`       | TypeScript           | Verifies CLI types against `cli/tsconfig.json`                               |
| `npm run lint`                | ESLint               | Lints TypeScript and React source code                                       |
| `npm run format:check`        | Prettier             | Checks code formatting adheres to repository standards                       |
| `npm run format`              | Prettier             | Automatically formats all files with Prettier                                |
| `npm run test:a11y`           | Accessibility (a11y) | Runs Playwright `@axe-core/playwright` accessibility audit                   |
| `npm run test:e2e`            | End-to-End           | Runs Playwright browser end-to-end tests                                     |
| `npm run test:visual`         | Visual Regression    | Runs Playwright visual regression snapshot tests for key pages               |
| `npm run test:visual:update`  | Visual Regression    | Updates baseline visual snapshots in `e2e/__screenshots__/`                  |
| `npm run db:check-drift`      | Prisma               | Verifies that Prisma schema and migrations are in sync                       |
| `npm run lint:openapi`        | OpenAPI              | Validates `openapi.yaml` with Spectral linter                                |
| `npm run verify:openapi`      | OpenAPI              | Checks that all public API routes are documented in `openapi.yaml`           |
| `npm run analyze`             | Bundle Analysis      | Generates `@next/bundle-analyzer` HTML reports for client & server           |
| `npm run check:bundle-budget` | Performance Budgets  | Compares per-route JS sizes against budgets in `bundle-budget.json`          |
| `npm run lhci:audit`          | Lighthouse CI        | Audits login & dashboard against `lighthouse-budget.json`                    |
| `npm run test:helm`           | Helm Chart           | Runs `helm-unittest` test suites under `helm/secureflow/tests/`              |
| `npm run test:helm:all`       | Helm Chart           | Runs full lint, rendering, and contract suite (`scripts/test-helm-chart.sh`) |

### Running Specific Tests

```bash
# Run a specific test file
npx vitest run src/lib/severity.test.ts

# Run tests in interactive watch mode
npx vitest src/components/theme-toggle.test.tsx

# Run scanner prompt golden regression tests (mocked, zero LLM cost)
npx vitest run src/lib/armor/prompt-regression.test.ts
```

### ⎈ Testing the Helm Chart Locally

SecureFlow uses [`helm-unittest`](https://github.com/helm-unittest/helm-unittest) to unit-test Kubernetes manifests generated by the Helm chart without requiring an active cluster. Tests live under `helm/secureflow/tests/` and cover `Deployment`, `Service`, `Ingress`, `ServiceMonitor`, and secret providers with default and overridden values.

#### 1. Prerequisites

Install [Helm](https://helm.sh/docs/intro/install/) (v3.12+). Then install the `helm-unittest` plugin:

```bash
helm plugin install https://github.com/helm-unittest/helm-unittest.git
```

#### 2. Running Helm Unit Tests

```bash
# Run all Helm unit tests
helm unittest helm/secureflow

# Or via npm script
npm run test:helm

# Run a specific template test suite
helm unittest -f 'tests/deployment_test.yaml' helm/secureflow
helm unittest -f 'tests/service_test.yaml' helm/secureflow
helm unittest -f 'tests/ingress_test.yaml' helm/secureflow
helm unittest -f 'tests/servicemonitor_test.yaml' helm/secureflow
helm unittest -f 'tests/secret_test.yaml' helm/secureflow
```

#### 3. Running Chart Linting & Contract Verification

```bash
# Lint the chart templates with required secrets
helm lint helm/secureflow --set secrets.authSecret=local-test-only

# Run chart-testing (ct lint)
ct lint --config .github/ct.yaml --charts helm/secureflow

# Run the complete lint, render, and contract verification script
bash scripts/test-helm-chart.sh
# Or via npm script
npm run test:helm:all
```

### ⚡ JavaScript Bundle Size & Lighthouse Performance Budgets

To prevent silent performance regressions where new dependencies make the dashboard heavier and slower, SecureFlow enforces automated bundle size budgets and Lighthouse score gates.

#### 1. Bundle Size Budgets (`bundle-budget.json`)

Per-route JavaScript budgets are configured in `bundle-budget.json`. During CI (`npm run check:bundle-budget`), per-route JavaScript sizes are extracted from Next.js build manifests and checked against:

- **Absolute Limit (`budgetKb`)**: Maximum allowed JavaScript size for that route.
- **Growth Threshold (`maxRouteGrowthPercent` & `maxRouteGrowthKb`)**: Maximum allowed increase relative to the recorded baseline.

```bash
# Run bundle budget verification locally
npm run check:bundle-budget

# Generate interactive bundle analysis reports (.next/analyze/client.html)
npm run analyze
```

#### 2. Lighthouse CI Quality Gate (`lighthouse-budget.json`)

Critical user journeys (the authentication sign-in page `/api/auth/signin` and Mission Control `/dashboard`) are continuously audited for Performance, Accessibility, and Best Practices. Results are automatically published to the GitHub Actions Job Summary (`$GITHUB_STEP_SUMMARY`).

```bash
# Run Lighthouse audits locally
npm run lhci:audit
```

#### 3. How to Adjust Budgets with Justification

Budgets exist to maintain blazing-fast page loads. If an intentional, impactful feature requires adjusting a route's budget in `bundle-budget.json` or `lighthouse-budget.json`, you **must** include a written justification in your pull request description:

1. **New Dependency / Component**: Name the newly introduced dependency or component and its bundle impact.
2. **Code Splitting & Lazy Loading**: Explain why dynamic imports (`next/dynamic`) or lighter alternative libraries could not reduce the footprint.
3. **Before & After Impact**: Provide the output table from `npm run check:bundle-budget` showing route sizes before and after the change.
4. **Maintainer Sign-Off**: Pull requests with budget increases require explicit maintainer review.

### Visual Regression Testing & Snapshot Baselines

SecureFlow uses Playwright visual comparison tests (`toHaveScreenshot`) to catch accidental layout breaks, overlapping tables, missing badges, or broken dark/light themes before merging.

#### Guaranteed Determinism

To avoid test flakiness and pixel jitter, visual tests execute with:

- **Standardized Viewport**: Fixed 1280×900 desktop viewport.
- **Fixed System Clock**: Frozen to a deterministic UTC timestamp (`2026-01-15T12:00:00.000Z`).
- **Disabled Animations**: Global CSS overrides disabling CSS transitions, animations, and blinking carets.
- **Font Settlement**: Pre-waited `document.fonts.ready` before capturing screenshots.
- **Masked Dynamic Regions**: Timestamps (`<time>`, `.time-ago`), user avatars, and animated spinners/pulse indicators are masked.
- **Strict Diff Threshold**: Snapshot assertions enforce `maxDiffPixelRatio: 0.02`.

#### Running Tests Locally

```bash
# Run visual regression suite against local server
npm run test:visual
```

#### Reviewing Diffs & Updating Baselines

When intentional UI changes or design updates alter dashboard layouts, baseline snapshots must be reviewed and regenerated:

```bash
# Update baseline images in e2e/__screenshots__/
npm run test:visual:update
```

Always inspect the updated images in `git diff` before committing to ensure only intended visual changes are included.

#### Opt-In CI Workflow & Diff Artifacts

Visual regression tests run in CI as an opt-in workflow (`.github/workflows/visual-regression.yml`):

- **Triggers**: Manually via `workflow_dispatch`, or automatically on pull requests labeled `visual-regression` or titled with `[visual]`.
- **Failure Artifacts**: When differences exceed `maxDiffPixelRatio: 0.02`, the workflow automatically uploads diff images and Playwright reports as workflow artifacts (`visual-regression-diffs`) for quick triage.

---

## 📁 Branch Naming Conventions

Always branch from `main` and use descriptive branch names following the format `<type>/<short-description>`:

```
<type>/<kebab-case-description>
```

### Branch Types

| Prefix      | Purpose                                    | Example                                          |
| :---------- | :----------------------------------------- | :----------------------------------------------- |
| `feat/`     | New features or capabilities               | `feat/cli-init-config`, `feat/dark-mode-toggle`  |
| `fix/`      | Bug fixes or issue resolutions             | `fix/findings-table-sort`, `fix/webhook-timeout` |
| `docs/`     | Documentation improvements                 | `docs/contributor-guide-difficulty-labels`       |
| `test/`     | Adding, updating, or fixing tests          | `test/cli-output-snapshot-tests`                 |
| `refactor/` | Code refactoring without behavioral change | `refactor/finding-card-components`               |
| `perf/`     | Performance optimizations                  | `perf/cache-finding-counts`                      |
| `ci/`       | CI/CD workflows and automation             | `ci/dependabot-npm-audit-workflow`               |
| `chore/`    | Tooling, dependencies, or maintenance      | `chore/update-prisma-v7`                         |

### Examples:

- ✅ `feat/cli-init-config`
- ✅ `fix/finding-status-filter-sync`
- ✅ `docs/contributor-guide-difficulty-labels`
- ❌ `my-changes` _(too vague)_
- ❌ `feat_cli` _(use hyphens and kebab-case)_
- ❌ `patch-1` _(not descriptive)_

---

## 📝 Commit Guidelines (Conventional Commits)

We enforce the [Conventional Commits](https://www.conventionalcommits.org/) specification for clear, readable git logs and automated changelog generation.

### Commit Format

```
<type>(<optional-scope>): <description>
```

- **Type**: Must be one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `ci`, `chore`, `security`.
- **Scope**: _(Optional)_ The module, component, or package being touched (e.g., `cli`, `a11y`, `auth`, `findings`).
- **Description**: Use imperative, present tense ("add", not "added" or "adds"). Lowercase, no ending period.

### Commit Types & Examples

| Type       | Description                                             | Example                                                          |
| :--------- | :------------------------------------------------------ | :--------------------------------------------------------------- |
| `feat`     | A new feature or enhancement                            | `feat(cli): add interactive secureflow init command`             |
| `fix`      | A bug fix                                               | `fix(findings): sync search and severity filter with URL params` |
| `docs`     | Documentation only changes                              | `docs: add difficulty labels and running instructions to guide`  |
| `style`    | Code formatting, whitespace, semi-colons                | `style: format severity theme with Prettier`                     |
| `refactor` | Code change that neither fixes a bug nor adds a feature | `refactor(scanner): modularize diff parser utilities`            |
| `perf`     | A code change that improves performance                 | `perf(audit): add in-memory caching for user filter queries`     |
| `test`     | Adding missing tests or correcting existing tests       | `test(cli): add output snapshot tests for plain text summary`    |
| `ci`       | Changes to CI configuration files and scripts           | `ci: add automated audit workflow for dependencies`              |
| `chore`    | Maintenance tasks, dependency updates, tooling          | `chore: update dependencies to latest patch versions`            |
| `security` | A security fix or vulnerability remediation             | `security: enforce HMAC verification on incoming webhooks`       |

---

## 🔄 Contribution Lifecycle & Issue Workflow

```
1. Browse Issues & Pick a Label (level1, level2, or level3)
   ↓
2. Comment on the Issue & Get Assigned
   ↓
3. Fork & Branch from main: git checkout -b feat/your-feature
   ↓
4. Make Changes & Write Tests
   ↓
5. Run Local Verifications (npm test, npm run lint, npm run typecheck)
   ↓
6. Add Changeset (if runtime behavior changed): npx changeset
   ↓
7. Commit with Conventional Commits: git commit -m "feat: ..."
   ↓
8. Push to Fork & Open Pull Request
   ↓
9. Pass CI Checks & Incorporate Reviewer Feedback
   ↓
10. Merge to main! 🎉
```

1. **Search existing issues** before creating a new one to prevent duplicate effort.
2. **Comment on the issue** you wish to work on before starting to ensure no someone else is already tackling it.
3. **Keep PRs focused**: Each PR should address a single issue or cohesive feature. Avoid bundling unrelated fixes together.

---

## ✅ Pull Request Process & Complete Checklist

### PR Verification Commands

Before submitting a PR, make sure the following checks pass cleanly on your branch:

```bash
# 1. Run all tests
npm test
npm run cli:test

# 2. Verify types
npm run typecheck
npm run cli:typecheck

# 3. Check linting and formatting
npm run lint
npm run format:check

# 4. Verify database schema synchronization (if touched schema.prisma)
npm run db:check-drift

# 5. Check accessibility (if touched dashboard UI)
npm run test:a11y

# 6. Verify OpenAPI documentation (if added or modified HTTP API routes)
npm run lint:openapi
npm run verify:openapi

# 7. Add a changeset (if runtime or CLI behavior changed)
npx changeset
```

---

### PR Description Template

When opening a Pull Request, use the standard template below:

```markdown
## Description

<!-- Briefly describe what changes were made and why -->

## Type of Change

- [ ] 🟢 Bug fix (non-breaking change fixing an issue)
- [ ] 🟡 New feature (non-breaking change adding functionality)
- [ ] 🔴 Breaking change (fix or feature causing existing functionality to break)
- [ ] 📚 Documentation update
- [ ] 🧪 Test suite addition or enhancement

## Difficulty Level

- [ ] `level1` (Beginner)
- [ ] `level2` (Intermediate)
- [ ] `level3` (Advanced)

## How Has This Been Tested?

<!-- Describe the tests you ran to verify your changes -->

- [ ] Unit & integration tests pass (`npm test` and `npm run cli:test`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Lint & format check pass (`npm run lint` and `npm run format:check`)
- [ ] Tested manually locally (describe steps)

## Related Issues

<!-- Link the issue using GitHub syntax: Closes #123 -->

Closes #

## Checklist

- [ ] My code adheres to the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code where appropriate
- [ ] I have added tests demonstrating that my fix/feature works
- [ ] All new and existing tests pass locally
- [ ] Commits follow Conventional Commits format
- [ ] Added a changeset via `npx changeset` (if changing runtime or CLI behavior)
- [ ] Run `npm run db:check-drift` to verify Prisma schema and migration alignment
```

---

### Interactive Checklist

- [ ] **Tests Added**: Every new feature or bug fix includes corresponding Vitest tests.
- [ ] **Zero Regressions**: Existing tests continue to pass without unexpected failures.
- [ ] **No Secrets Committed**: Never commit real API keys, tokens, or passwords to git.
- [ ] **Documentation Updated**: Relevant sections in `README.md`, `docs/`, or JSDocs are updated.
- [ ] **Changeset Created**: Changeset file exists in `.changeset/` for runtime changes.

---

## 💻 Coding Standards

### TypeScript

- Always use explicit types; avoid `any`.
- Define clear interfaces and schemas (using Zod where runtime validation is required).
- Add JSDoc comments explaining parameters, return values, and failure modes for public functions.

```typescript
// ✅ Good: Typed interfaces and clear JSDoc
export interface RemediationOptions {
  findingId: string;
  provider?: "groq" | "ollama" | "vllm" | "openai";
  timeoutMs?: number;
}

/**
 * Generates an actionable remediation diff for a security finding.
 */
export async function generateRemediation(options: RemediationOptions): Promise<RemediationResult> {
  // Implementation...
}

// ❌ Bad: Untyped any and implicit returns
export async function generateRemediation(options: any) {
  // Implementation...
}
```

### ESLint & Prettier

- Run `npm run lint` to catch syntax and linting errors.
- Run `npm run format` to automatically format all TypeScript, JavaScript, JSON, and Markdown files.

---

## 📚 Documentation Standards

- Keep explanations concise, practical, and beginner-friendly.
- Include code examples, expected output, and CLI flags for complex features.
- Update `README.md` and related documents in `docs/` whenever introducing new flags, configuration options, or commands.
- Ensure all markdown links are valid and point to existing files or anchors.

---

## 📦 Changelog (Changesets)

SecureFlow uses [Changesets](https://github.com/changesets/changesets) to manage versioning and maintain [`CHANGELOG.md`](./CHANGELOG.md) across releases.

If your PR introduces a new feature, fixes a bug, updates database migrations, or changes CLI behavior, create a changeset before opening your PR:

```bash
npx changeset
```

Follow the interactive prompts to choose the change severity (`patch`, `minor`, `major`) and enter a clear description of what changed. Commit the generated markdown file in `.changeset/`.

---

## 📁 Folder Structure Explained

```
SecureFlow/
├── cli/                        # SecureFlow CLI workspace (npm workspace)
│   ├── src/                    # CLI source code
│   │   ├── lib/                # TUI formatters, API client, local mode
│   │   ├── mcp/                # Model Context Protocol server tools
│   │   ├── git.ts              # Git diff & staged file utilities
│   │   ├── scanner.ts          # Secret & vulnerability detection rules
│   │   └── index.ts            # CLI entry point (secureflow executable)
│   └── package.json            # CLI package manifest
├── docs/                       # Technical architecture & setup guides
├── e2e/                        # Playwright E2E and accessibility test suites
├── prisma/                     # Database schema, migrations, and seeds
│   ├── schema.prisma           # Prisma data models
│   └── migrations/             # Applied SQL migrations
├── public/                     # Static assets, fonts, icons
├── scripts/                    # Maintenance, audit chain, and verification scripts
├── src/                        # Next.js App Router source
│   ├── ai/                     # LLM orchestration, model config, Genkit flows
│   ├── app/                    # Next.js pages, layouts, and API route handlers
│   │   ├── api/                # REST endpoints and GitHub webhook receiver
│   │   ├── dashboard/          # Mission Control dashboard pages
│   │   └── login/              # Authentication and login views
│   ├── components/             # Reusable UI components & React hooks
│   └── lib/                    # Core business logic, queues, security armor
└── package.json                # Root package manifest & workspace config
```

---

## 💡 Tips for First-Time Contributors

1. **Start with a `level1` issue**: Search for issues tagged with `level1` or `good first issue` to make your first contribution smoothly.
2. **Use Mock Mode**: You don't need real API keys or databases to work on the UI. Set `NEXT_PUBLIC_MOCK_AUTH=true` and run `npm run dev`.
3. **Run tests early and often**: Run `npx vitest <your-file>.test.ts` while coding to get instant feedback in watch mode.
4. **Ask questions**: If an issue description is ambiguous or you're unsure about the architectural direction, leave a comment on the issue. Maintainers and community members are happy to help!
5. **Keep commits clean**: Use Conventional Commits (`feat:`, `fix:`, `docs:`) so release notes stay clear and organized.

---

## ❓ FAQ for Contributors

**Do I need a Groq API key or GitHub App to run tests?**  
No. All automated unit and integration tests run with mock adapters and synthetic keys (`GROQ_API_KEY=test-key`). You can run `npm test` and `npm run cli:test` immediately after `npm install`.

**How long does PR review typically take?**  
Maintainers aim to review pull requests within 2 to 4 business days. High-quality PRs with tests and passing CI checks are reviewed fastest!

**What should I do if CI fails on formatting?**  
Simply run `npm run format` locally, commit the changes, and push.

**Can I work on multiple issues simultaneously?**  
We recommend focusing on one issue at a time so PRs remain small, fast to review, and easy to merge without merge conflicts.

---

## 🙏 Thank You

Every contribution — whether it's fixing a typo, improving accessibility, adding a CLI flag, or architecting a new security analysis flow — makes SecureFlow better for developers and security teams around the world.

**Happy hacking, and welcome to the crew! 🚀**

---

<div align="center">

**Made with ❤️ by the SecureFlow Community**

[Report a Bug](https://github.com/GauravKarakoti/SecureFlow/issues) · [Request a Feature](https://github.com/GauravKarakoti/SecureFlow/issues) · [Browse Issues](https://github.com/GauravKarakoti/SecureFlow/issues)

</div>
