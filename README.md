<div align="center">

# 🎭 SecureFlow

## The Digital Heist Defense System — AI-Powered GitHub Pull Request Security Scanner

[![GitHub stars](https://img.shields.io/github/stars/GauravKarakoti/SecureFlow?style=for-the-badge&color=gold)](https://github.com/GauravKarakoti/SecureFlow/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/GauravKarakoti/SecureFlow?style=for-the-badge&color=blue)](https://github.com/GauravKarakoti/SecureFlow/network)
[![GitHub issues](https://img.shields.io/github/issues/GauravKarakoti/SecureFlow?style=for-the-badge&color=red)](https://github.com/GauravKarakoti/SecureFlow/issues)
[![GitHub license](https://img.shields.io/github/license/GauravKarakoti/SecureFlow?style=for-the-badge&color=green)](https://github.com/GauravKarakoti/SecureFlow/blob/main/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/GauravKarakoti/SecureFlow/blob/main/CONTRIBUTING.md)
[![Made with Next.js](https://img.shields.io/badge/Made%20with-Next.js-000000?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)](https://www.prisma.io/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![SecureFlow Status](https://secure-flow-six.vercel.app/api/badge/GauravKarakoti/SecureFlow)](https://secure-flow-six.vercel.app)

> _"In this heist, we're not stealing — we're protecting."_
> **SecureFlow automatically detects vulnerabilities, hardcoded secrets, and code flaws before they reach production.**

[![Nexus Spring of Code](https://www.nsoc.in/_next/image?url=%2Fnsoc-logo-dark.webp&w=96&q=75)](https://www.nsoc.in/)

Featured in Nexus Spring of Code

</div>

---

## 📋 Table of Contents

<details>
<summary><b>Click to expand</b></summary>

- [🌟 The Crew's Abilities (Features)](#-the-crews-abilities-features)
- [🧠 The Blueprint (How It Works)](#-the-blueprint-how-it-works)
- [🛠️ Tech Stack](#️-tech-stack)
- [📁 Project Structure](#-project-structure)
- [🚀 Joining the Resistance (Getting Started)](#-joining-the-resistance-getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Fork & Clone](#1-fork--clone)
  - [2. Environment Variables](#2-environment-variables)
  - [3. GitHub App Setup](#3-github-app-setup)
  - [4. Database Setup](#4-database-setup)
  - [5. Run the App](#5-run-the-app)
- [🐳 Docker Setup](#-docker-setup)
- [🔑 Environment Variables Reference](#-environment-variables-reference)
- [📝 Available Scripts](#-available-scripts)
- [🔒 Defense Strategy (Security Policies)](#-defense-strategy-security-policies)
- [📊 Architecture](#-architecture)
- [📖 Technical Documentation](#-technical-documentation)
- [🤝 Contributing & Difficulty Labels](#-contributing)
- [❓ FAQ](#-faq)
- [📄 License](#-license)

</details>

---

SecureFlow integrates directly with GitHub via a GitHub App and webhooks. Every time a Pull Request is opened or updated, **The Professor** — SecureFlow's AI mastermind — extracts the code diff, runs it through Groq's LLM (GPT-OSS-20B), and returns actionable security findings with AI-written explanations and remediation steps, all visible on a centralized Mission Control dashboard.

Think of every Pull Request as a member of the crew trying to get into **The Vault** (your codebase). The Professor checks their credentials at the door — no leaked keys, no sloppy code, no breaches on his watch.

## 🌟 The Crew's Abilities (Features)

### 🤖 AI-Powered Detection

Uses Groq's GPT-OSS-20B to detect hardcoded secrets, vulnerabilities, and misconfigurations in your code.

### ⚡ Real-time Scanning

Automatically scans every opened or updated Pull Request as soon as it's created — The Professor never sleeps.

### 🛡️ Smart Remediation

Generates precise explanations and concrete code fixes for each security finding.

### 📊 Mission Control Dashboard

View all your repositories, PRs, findings, and audit logs in one unified command center. Includes a keyboard-accessible **Command Palette** (`Ctrl+K` or `⌘K`) for rapid navigation and quick actions across sections.

### 💬 GitHub PR Comments

Posts detailed security reports directly on your PRs with collapsible remediation blocks.

### ✅ GitHub Check Runs

Sets Pass/Review Required/Blocked status on PR commits for clear CI/CD integration.

### 🎯 Custom Policies

Create, toggle, and manage security policies per user or organization — write your own rules for the plan.

### 🚫 Smart Exclusions

Intelligently ignores non-executable files and mock placeholders to reduce noise.

### 🛡️ Finding Triage & Dismissal

Maintainers can dismiss findings directly from the dashboard:

- **Status & Reason**: Triage findings as `DISMISSED` with a required reason category (`False positive`, `Accepted risk`, or `Won't fix`) and an optional explanation note.
- **Stable Fingerprints**: Findings generate deterministic SHA-256 fingerprints (`repositoryId + fileLocation + type + codeSnippet`) so dismissals reliably persist across commits and subsequent scans.
- **Scan-time Suppression**: Dismissed findings are automatically suppressed during PR scans—they do not block pull requests or inflate open finding tallies, and are reported as previously dismissed in PR scan summaries.
- **Audit Trail & Reversal**: Every dismissal and reopening action is logged in the Vault Audit Log with actor identity, timestamp, and notes. Reopening restores findings to `OPEN` status instantly.
- **Current PR Verdict**: Triage refreshes the latest saved scan and its existing GitHub check when that scan matches the PR's current commit. Older scans without a recorded commit, or PRs with a newer unscanned commit, need a fresh scan before the verdict changes. The dashboard shows this pending state after saving.

---

## 🧠 The Blueprint (How It Works)

```
Developer opens or updates a Pull Request
              ↓
GitHub sends a webhook event to SecureFlow
              ↓
Octokit extracts the code diff (added/modified lines only)
              ↓
ArmorIQScanner sends the diff to Groq LLM with active policy context
              ↓
LLM returns structured findings (type, severity, file, snippet)
              ↓
For each finding → The Professor generates explanation + remediation steps
              ↓
Findings saved to PostgreSQL via Prisma — the Vault Logs
              ↓
Results posted as a GitHub PR comment + commit check status
              ↓
Everything visible on the SecureFlow Mission Control Dashboard
```

### What Gets Detected

| Category                    | Examples                                              |
| --------------------------- | ----------------------------------------------------- |
| 🔑 **Hardcoded Secrets**    | API keys, passwords, tokens committed in code         |
| 📤 **Contextual Leaks**     | `console.log(process.env)`, logging sensitive objects |
| ⚙️ **Misconfigurations**    | Wildcard CORS, disabled auth, insecure headers        |
| 🧱 **Code Vulnerabilities** | SQL injection patterns, unsafe deserialization        |
| ☁️ **IaC Issues**           | Public S3 buckets, root container execution           |

---

## 🔐 Deterministic Secret Pre-Screen

Before a PR diff is sent to the LLM, SecureFlow runs a rule-based secret scan
(`src/lib/armor/secret-detector.ts`) over the added lines only.

- **Detects:** AWS access key IDs, GitHub tokens, Slack tokens, PEM private key
  headers, and high-entropy values assigned to secret-named variables
  (`password`, `secret`, `token`, `apiKey`).
- **Severity:** every deterministic secret finding is `CRITICAL`.
- **No false alarms on samples:** values labelled `EXAMPLE` / `changeme`, env
  lookups, and low-entropy values are not flagged.
- **Masked everywhere:** stored findings, PR comments and dashboards only show a
  masked form of the value. The raw secret is never persisted or posted, and it
  is not part of the request sent to Groq.
- **Merge and de-duplicate:** if the LLM reports the same file and line as a
  deterministic finding, only one finding is shown (the deterministic one wins).
- **Graceful degradation:** if the LLM call fails or times out, the deterministic
  findings are still saved and reported.

Run its tests:

    npx vitest run src/lib/armor/secret-detector.test.ts src/lib/armor/secret-detector.prescreen.test.ts src/lib/armor/secret-detector.llm-payload.test.ts

---

## 🛠️ Tech Stack

| Layer                  | Technology                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Framework**          | [Next.js 16](https://nextjs.org/) - App Router + Turbopack                                                           |
| **Database**           | PostgreSQL + [Prisma ORM](https://www.prisma.io/)                                                                    |
| **Authentication**     | [NextAuth.js v5](https://authjs.dev/) with GitHub OAuth                                                              |
| **AI / LLM**           | [Groq SDK](https://groq.com/) (`openai/gpt-oss-20b`) + [Genkit](https://firebase.google.com/docs/genkit)             |
| **GitHub Integration** | [Octokit](https://github.com/octokit/octokit.js)                                                                     |
| **UI**                 | [Tailwind CSS](https://tailwindcss.com/) + [Radix UI](https://www.radix-ui.com/) + [Recharts](https://recharts.org/) |

---

## 📁 Project Structure

```
secureflow/
├── docs/
│   ├── api.md                   # API route endpoints and specifications
│   ├── blueprint.md             # Brand, style guidelines, and terminology dictionary
│   ├── runbook.md               # Operations runbook for diagnosing failed scans and outages
│   └── security/
│       └── prompt-injection.md  # Security controls and defenses for LLM prompt injections
│
├── prisma/
│   ├── migrations/              # Database migration history
│   ├── schema.prisma            # Database schema (User, Repo, PR, Finding, etc.)
│   └── seed.ts                  # Seeds default security policy templates
│
├── src/
│   ├── ai/
│   │   └── flows/
│   │       └── developer-receives-ai-security-explanations.ts  # The Professor's Genkit AI flow
│   │
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/            # NextAuth route handler
│   │   │   └── webhooks/
│   │   │       └── github/
│   │   │           └── route.ts # Main webhook handler (PR scanning logic)
│   │   │
│   │   ├── dashboard/
│   │   │   ├── audit/           # Vault Logs (audit log page)
│   │   │   ├── findings/        # Breach Attempts (security findings page)
│   │   │   ├── policies/        # Defense Strategy (policy management page)
│   │   │   └── page.tsx         # Mission Control (main dashboard overview)
│   │   │
│   │   ├── login/               # Login page
│   │   └── setup/               # GitHub App installation setup page
│   │
│   ├── components/
│   │   ├── ui/                  # Radix UI + shadcn components
│   │   └── dashboard-nav.tsx    # Sidebar navigation
│   │
│   └── lib/
│       ├── armor/
│       │   ├── scanner.ts       # ArmorIQScanner — core LLM scanning engine
│       │   └── iq.ts            # ArmorIQ policy engine + evaluation logic
│       └── prisma.ts            # Prisma client singleton
```

---

## 🚀 Joining the Resistance (Getting Started)

### Prerequisites

Make sure you have the following installed and ready before the heist begins:

- [Node.js v20+](https://nodejs.org/)
- [PostgreSQL](https://www.postgresql.org/) (local) or a free cloud DB ([Neon](https://neon.tech) / [Supabase](https://supabase.com))
- A [Groq API Key](https://console.groq.com/) (free tier available)
- A GitHub Account to create a GitHub App

---

### 1. Fork & Clone

- Fork the repo on GitHub first, then:

```bash
git clone https://github.com/YOUR_USERNAME/secureflow.git
```

```bash
cd secureflow
```

```bash
npm install
```

---

### 2. Environment Variables

```bash
cp .env.example .env
```

> ⚠️ **Important**: Fill in your `.env` file. See [Environment Variables Reference](#-environment-variables-reference) for details on each value.

---

### 3. GitHub App Setup

SecureFlow requires a GitHub App to receive webhook events and post PR comments.

1. Go to **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**
2. Fill in the following:
   - **Homepage URL**: `http://localhost:9002`
   - **Webhook URL**: Your public URL + `/api/webhooks/github` (use [ngrok](https://ngrok.com/) for local dev: `ngrok http 9002`)
   - **Webhook Secret**: Any random string — copy it to `GITHUB_WEBHOOK_SECRET` in `.env`
3. Set these **Repository Permissions**:
   - Contents: `Read`
   - Pull Requests: `Read & Write`
   - Checks: `Read & Write`
4. Subscribe to these **Webhook Events**:
   - `Pull request`
   - `Installation`
   - `Installation repositories`
5. After creating the app:
   - Copy the **App ID** → `GITHUB_APP_ID`
   - Generate a **Private Key** → download the `.pem` file, copy its contents → `GITHUB_PRIVATE_KEY`
   - Create a **Client ID & Secret** under OAuth → `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

---

### 4. Database Setup

**Option A — Local PostgreSQL (Development):**

```sql
-- In psql or pgAdmin:
CREATE DATABASE secureflow;
```

Set your local connection string in `.env`:

```env
DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/secureflow"
```

**Option B — Production Serverless with Connection Pooling (Neon / PgBouncer):**

In serverless environments (Next.js API routes on Vercel/AWS Lambda), multiple concurrent function instances spin up rapidly under heavy traffic. Without connection pooling, this can quickly exhaust PostgreSQL connection limits.

SecureFlow supports connection poolers (e.g. **Neon Pooler** or **PgBouncer**) paired with Prisma's native `pg` driver pool adapter (`@prisma/adapter-pg`).

Configure your production `.env` / environment settings with database connection strings:

```env
# Standard / Direct Database connection string (Used by Prisma CLI for migrations & fallback)
DATABASE_URL="postgresql://neondb_owner:pass@ep-direct.c-9.us-east-1.aws.neon.tech/neondb?sslmode=verify-full"

# Application Runtime Query Pooler URL (Optional: PgBouncer / Neon connection pooler)
DATABASE_POOL_URL="postgresql://neondb_owner:pass@ep-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=verify-full"

# Optional: Max connections per serverless function instance pool (default: 10)
DB_POOL_MAX=10
```

> 💡 **Why database pooler?** SecureFlow uses `DATABASE_POOL_URL` for application runtime queries in serverless production environments while Prisma CLI migrations automatically use `DATABASE_URL` (direct connection string).

**Then run database setup:**

- Generate Prisma Client

```bash
npm run db:gen
```

- Apply migrations (creates all tables using `DATABASE_URL`)

```bash
npm run db:migrate
```

- Seed default security policy templates

```bash
npm run db:seed
```

---

### 5. Run the App

```bash
npm run dev
```

Open [http://localhost:9002](http://localhost:9002) in your browser.

- Sign in with GitHub
- Install the GitHub App on your repositories via the Setup page
- Open a Pull Request on any linked repo to trigger a scan — and let The Professor take it from there

**Optional — Genkit AI dev environment** (for working on AI explanation flows):

```bash
npm run genkit:dev
```

---

## 🐳 Docker Setup

1. Copy `.env.example` to `.env` and fill in values (note: `DATABASE_URL` is auto-set by compose)
2. `docker compose up --build`
3. App runs at [http://localhost:9002](http://localhost:9002)

### Container Security & Non-Root Execution

SecureFlow's Docker image uses a secure multi-stage build running as an unprivileged user:

- **Non-root execution**: The final runtime container creates and runs under the unprivileged `nextjs` user (`UID 1001`, `GID 1001`), ensuring processes never run as `root` (id verifies non-zero UID).
- **Multi-stage isolation**: Build tools and dev dependencies are discarded; only the Next.js standalone bundle, public assets, and production client artifacts are included.
- **Built-in HEALTHCHECK**: Container liveness is continuously monitored via a native `HEALTHCHECK` directive.
- **Database migrations**: Managed cleanly via dedicated one-shot migrator or Kubernetes hooks with non-root privileges.

### 🔐 Container Image Signing & Supply Chain Verification

All official SecureFlow container images (`ghcr.io/gauravkarakoti/secureflow`) are cryptographically signed with **Sigstore Cosign** via GitHub OIDC, and published with attached **CycloneDX SBOM** and **SLSA Build Provenance** attestations.

#### 1. Verify Image Signature:

```bash
cosign verify \
  --certificate-identity-regexp "^https://github\.com/GauravKarakoti/SecureFlow/\.github/workflows/docker-publish\.yml@refs/tags/v.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/gauravkarakoti/secureflow:latest
```

#### 2. Verify CycloneDX SBOM Attestation:

```bash
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp "^https://github\.com/GauravKarakoti/SecureFlow/\.github/workflows/docker-publish\.yml@refs/tags/v.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/gauravkarakoti/secureflow:latest
```

#### 3. Verify SLSA Build Provenance:

```bash
gh attestation verify oci://ghcr.io/gauravkarakoti/secureflow:latest \
  --repo GauravKarakoti/SecureFlow
```

For detailed provenance extraction and Kubernetes admission controller (Kyverno) policies, see the **[Container Image Verification Guide](./docs/deployment.md#8-container-image-verification--supply-chain-security-cosign--slsa-provenance-1926)**.

### Upgrading SecureFlow

When upgrading between releases, follow our step-by-step checklist covering database backups, migration execution, health validation, and rollback procedures in the **[Safe Upgrade Guide](./docs/upgrade.md)**.

---

## 🔑 Environment Variables Reference

| Variable                  | Required | Description                                                                                               |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | ✅       | PostgreSQL connection string (Direct/Standard)                                                            |
| `DATABASE_POOL_URL`       | ⬜       | Recommended for production serverless connection pooler (PgBouncer/Neon Pooler)                           |
| `DB_POOL_MAX`             | ⬜       | Max connections per serverless function instance (default: 10)                                            |
| `GROQ_API_KEY`            | ✅       | API key from [console.groq.com](https://console.groq.com)                                                 |
| `AI_PROVIDER`             | ⬜       | AI provider for remediation & explanations: `groq` (default), `ollama`, `vllm`, `openai`, `custom`        |
| `AI_MODEL`                | ⬜       | Model identifier override (e.g. `openai/gpt-oss-20b`, `llama-3.3-70b-versatile`, `llama3`, `gpt-4o-mini`) |
| `AI_BASE_URL`             | ⬜       | Optional API base URL override for local or custom inference gateways (e.g. `http://localhost:11434/v1`)  |
| `GITHUB_APP_ID`           | ✅       | Numeric ID of your GitHub App                                                                             |
| `GITHUB_WEBHOOK_SECRET`   | ✅       | Secret used to verify webhook payloads                                                                    |
| `GITHUB_PRIVATE_KEY`      | ✅       | RSA private key from your GitHub App (`.pem` contents)                                                    |
| `GITHUB_APP_URL`          | ✅       | Public URL of your GitHub App (e.g. `https://github.com/apps/your-app`)                                   |
| `GITHUB_CLIENT_ID`        | ✅       | OAuth Client ID for GitHub login                                                                          |
| `GITHUB_CLIENT_SECRET`    | ✅       | OAuth Client Secret for GitHub login                                                                      |
| `AUTH_SECRET`             | ✅       | Random secret for NextAuth session encryption — generate with `openssl rand -base64 32`                   |
| `ARMORIQ_API_KEY`         | ⬜       | Optional — ArmorIQ SDK key for advanced policy features                                                   |
| `USER_ID`                 | ⬜       | Optional — ArmorIQ user ID                                                                                |
| `AGENT_ID`                | ⬜       | Optional — ArmorIQ agent ID                                                                               |
| `TRUSTED_PROXY_HOP_COUNT` | ⬜       | Trusted proxies in front of the app (default: `0`). Set `1` behind a single proxy — see below             |
| `TRUSTED_PROXY_IPS`       | ⬜       | Optional — comma-separated proxy addresses / IPv4 CIDRs, used instead of a fixed hop count                |
| `DATA_RETENTION_DAYS`     | ⬜       | Optional — Auto-cleanup older findings, scans, and audit logs (default: unset / keep forever)             |
| `SCAN_CACHE_TTL_SECONDS`  | ⬜       | Scan deduplication cache TTL in seconds (default: `86400` / 24 hours)                                     |

### Trusted proxies and rate limiting

Rate limits are bucketed per client IP, and that IP is derived from
`X-Forwarded-For`. Because any caller can put whatever they like at the front of
that header, the app has to know how many hops in front of it are actually
trustworthy — otherwise a caller can vary the header and land in a fresh bucket
on every request, which makes every rate limit unenforceable.

Set `TRUSTED_PROXY_HOP_COUNT` to the number of proxies between the internet and
the app:

| Deployment                              | Value             |
| --------------------------------------- | ----------------- |
| Vercel / Render / Fly / a single nginx  | `1`               |
| Cloudflare in front of one of the above | `2`               |
| App exposed directly, no proxy          | `0` (the default) |

With `0` (or when the variable is unset), the forwarding headers are ignored
entirely — nothing in front of the app is authoritative, so nothing in them is
believed. Every caller then shares one rate-limit bucket, so **behind a proxy
you must set this**, or one busy client throttles everyone. The app logs a
one-time warning when it sees forwarding headers with the variable unset.

If the hop count varies (multiple ingress paths), set `TRUSTED_PROXY_IPS`
instead — e.g. `TRUSTED_PROXY_IPS=10.0.0.0/8,192.168.1.1`. The chain is then
walked from the right past known proxies rather than counting a fixed number of
hops. IPv4 CIDR blocks and bare addresses are supported; IPv6 entries are matched
exactly.

### Data retention and automated cleanup

Findings and audit logs accumulate over time. Self-hosters can bound storage growth by configuring `DATA_RETENTION_DAYS`:

```env
# Optional: Auto-cleanup findings and audit logs older than N days (off by default)
DATA_RETENTION_DAYS=90
```

Retention operations can be executed via the unified CLI script:

- **CLI Dry Run (default)**: `npm run retention` (reports eligible counts without modifying the database)
- **CLI Applied Deletion**: `npm run retention -- --apply` (purges eligible older records in batches)
- **CLI Custom Window**: `npm run retention -- --days=30 --apply`
- **CLI Custom Batch Size**: `npm run retention -- --batch-size=200 --apply`
- **CLI Target Isolation**: `npm run retention -- --only=auditLog --apply`

> 🛡️ **Safety Guarantee**: The retention cleanup strictly deletes older `Finding`, `ScanResult`, and `AuditLog` rows in safe batches. It **never deletes users, repositories, or policies**.

### 🤖 Configurable AI Models for Remediation & Explanations

The AI model powering vulnerability remediation patches and interactive security explanations can be configured via environment variables without modifying code. This enables operators to choose faster, cheaper, or air-gapped local models.

| Variable      | Supported Values                             | Default                                                                                                                                      | Description                                            |
| ------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `AI_PROVIDER` | `groq`, `ollama`, `vllm`, `openai`, `custom` | `groq`                                                                                                                                       | Backend inference provider                             |
| `AI_MODEL`    | Any model identifier or tag                  | `openai/gpt-oss-20b` (for `groq`), `llama3` (for `ollama`), `meta-llama/Meta-Llama-3-8B-Instruct` (for `vllm`), `gpt-4o-mini` (for `openai`) | Model used for analysis and patch generation           |
| `AI_BASE_URL` | Valid HTTP/HTTPS endpoint                    | Provider default (`http://localhost:11434/v1` for Ollama, `http://localhost:8000/v1` for vLLM)                                               | Endpoint base URL for custom gateways or local engines |

#### Examples

**Alternative cloud models with Groq:**

```env
AI_PROVIDER=groq
AI_MODEL=groq/llama-3.3-70b-versatile
```

**Local air-gapped inference with Ollama:**

```env
AI_PROVIDER=ollama
AI_MODEL=codellama
AI_BASE_URL=http://localhost:11434/v1
```

**Enterprise custom or on-prem gateway:**

```env
AI_PROVIDER=custom
AI_MODEL=my-fine-tuned-model
AI_BASE_URL=https://llm.corp.internal/v1
```

#### Startup Validation & Verbose Mode

At application or CLI startup, configuration values are validated immediately to prevent silent failures. Run with `--verbose` (or set `LOG_LEVEL=verbose`) to inspect the active model:

```bash
secureflow scan --verbose
# Output:
# ℹ️  [SecureFlow] Active AI model: provider=groq, model=openai/gpt-oss-20b
```

#### CI/CD Quality Gates (`--fail-on`) & Exit Codes

Configure failure thresholds for CI/CD pipelines to fail only when findings reach a chosen severity:

```bash
# Fail only if critical or high findings are detected
secureflow scan --fail-on high

# Zero-tolerance mode: fail on any finding
secureflow scan --fail-on low

# Advisory mode: report findings without failing the pipeline
secureflow scan --fail-on none
```

| Exit Code | Meaning                                                                             |
| :-------: | :---------------------------------------------------------------------------------- |
|    `0`    | Scan passed; findings are strictly below the `--fail-on` threshold (or 0 findings). |
|    `1`    | Scan threshold met or exceeded; findings at or above the threshold were found.      |
|    `2`    | Scan error (e.g. git failure, missing repository, or unreadable scan tree).         |

Before exiting, SecureFlow outputs a concise one-line count per severity:

```text
Findings by severity: critical: 0, high: 2, medium: 1, low: 0
```

---

## 📝 Available Scripts

| Script                     | Description                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev`              | Start dev server on port 9002 with Turbopack                                       |
| `npm run build`            | Build for production                                                               |
| `npm run start`            | Start production server                                                            |
| `npm run lint`             | Run ESLint                                                                         |
| `npm run typecheck`        | Run TypeScript compiler checks                                                     |
| `npm run db:gen`           | Generate Prisma Client                                                             |
| `npm run db:migrate`       | Run Prisma migrations                                                              |
| `npm run db:push`          | Push schema to DB without migrations                                               |
| `npm run db:seed`          | Seed default policy templates                                                      |
| `npm run db:backup`        | Create timestamped compressed PostgreSQL backup (`pg_dump`)                        |
| `npm run db:restore`       | Restore backup into PostgreSQL (`pg_restore`, requires `--force` for non-empty DB) |
| `npm run db:verify-backup` | Restore into ephemeral database and verify table counts & migrations               |
| `npm run genkit:dev`       | Start Genkit AI development environment                                            |
| `npm run retention`        | Unified data retention runner (dry-run default; pass `-- --apply` to delete)       |

---

## 🔒 Defense Strategy (Security Policies)

SecureFlow ships with pre-built policy templates that are seeded into the database. Users can toggle them on/off from the dashboard — think of it as briefing the crew before every job.

| Policy                                   | Severity | Default |
| ---------------------------------------- | -------- | ------- |
| Enforce Parameterized Queries            | HIGH     | ✅ On   |
| Prevent PII Logging                      | CRITICAL | Off     |
| Block Internal Network Requests (SSRF)   | HIGH     | Off     |
| Enforce Strict CORS Policies             | MEDIUM   | Off     |
| Prevent Unsafe Deserialization           | CRITICAL | Off     |
| Deprecate Weak Hashing Algorithms        | HIGH     | Off     |
| Deny Public Cloud Storage                | CRITICAL | Off     |
| Prevent Root Execution in Containers     | MEDIUM   | Off     |
| Enforce Smart Contract Reentrancy Guards | CRITICAL | Off     |

---

## 📊 Architecture

The architecture follows a modern Next.js full-stack approach with real-time GitHub integration:

- **Frontend**: Next.js App Router with Tailwind CSS for the Mission Control dashboard
- **Backend**: API routes handle authentication, webhooks, and business logic
- AI Layer: Groq SDK processes code diffs through GPT-OSS-20B model — The Professor's brain
- **Database**: PostgreSQL with Prisma ORM for data persistence — the Vault Logs
- **GitHub Integration**: Octokit manages webhooks, PR comments, and checks

> 📐 For the complete system architecture, interactive Mermaid sequence diagrams, component topologies, failure handling (DLQ, circuit breaker), and data models, see **[Architecture & Pipeline Specification](./docs/architecture.md)**.

---

## 📖 Technical Documentation

For more in-depth details about the architecture, developer API, and security practices of SecureFlow, check out:

- **[Architecture & Pipeline Specification](./docs/architecture.md)**: Visual architecture overview featuring Mermaid sequence diagrams, component topologies, failure handling (DLQ, circuit breaker), and PostgreSQL data models.
- **[Safe Upgrade Guide](./docs/upgrade.md)**: Standardized step-by-step operator checklist for upgrading SecureFlow releases, applying Prisma migrations, verifying `/api/health` and `/api/version`, and executing zero-data-loss rollbacks.
- **[Database Backup, Restore & Verification Guide](./docs/database-backup-restore.md)**: Procedures for compressed PostgreSQL dumps (`pg_dump`), safe restores with non-empty database safety guards, ephemeral database verification, Linux `cron`, and Kubernetes `CronJob` scheduling.
- **[Local Development Setup](./docs/setup.md)**: Step-by-step guide to acquiring every credential (Prisma/PostgreSQL, Groq, GitHub App, GitHub OAuth/NextAuth, Redis) needed to run SecureFlow locally.
- **[Kubernetes Deployment & Egress Hardening](./docs/deployment.md)**: Production deployment architecture, zero-trust network policies, and egress rule whitelisting for backend worker pods.
- **[System Blueprint](./docs/blueprint.md)**: Explains the application blueprint, core capabilities, style guidelines, visual tokens, and heist-themed copywriting dictionary.
- **[API Reference](./docs/api.md)**: Provides exhaustive details on HTTP endpoints, authentication, rate limits, error formats, and system types.
- **[Threat Model & STRIDE Analysis](./docs/threat-model.md)**: Comprehensive threat modeling across webhook ingestion, BullMQ worker queues, static scanning, LLM providers, PostgreSQL audit ledgers, and outbound dispatchers, detailing mitigations, trust boundaries, and residual risks.
- **[AI Security & Prompt Injection Defense](./docs/security/prompt-injection.md)**: Documents the threat vector, policy isolation boundaries, pre-filtering layers, and UI indicators used to protect against LLM prompt injection attacks.
- **[Threat Intelligence MCP Server](./docs/mcp-server.md)**: Guide to connecting IDE agents (Cursor, Claude Desktop, Windsurf) to the SecureFlow CLI MCP server with ArmorIQ cryptographic intent verification.
- **[Local Inference & VRAM Guide](./docs/local-inference.md)**: Hardware/VRAM requirements, memory management, and environment variables for air-gapped scanning with local Ollama and vLLM models.
- **[Operator Runbook](./docs/runbook.md)**: Operational troubleshooting guide for scan outages, webhook delivery failures, queue/Redis stalls, Groq rate limits, database pooling errors, and proxy configuration.
- **[Webhook Load Testing](./docs/load-testing.md)**: Performance benchmarks and k6 load testing suite for webhook ingestion throughput and response latency.
- **[Status Badge](./docs/status-badge.md)**: Embed a live SVG badge in your README showing the latest scan status.

---

## 🏷️ Status Badge

Add a live security-status badge to your repository README:

```markdown
![SecureFlow](https://secure-flow-six.vercel.app/api/badge/OWNER/REPO)
```

The badge reflects the latest scan: **passing** (green), **review required** (yellow), **blocked** (red), or **unknown** (grey). Enable it in your repository settings — see the [Status Badge docs](./docs/status-badge.md) for details.

---

## 🤝 Contributing

Every good heist needs a crew! Contributions are welcome from developers of all skill levels.

For a comprehensive, self-contained guide covering prerequisites, running the CLI and dashboard locally, running tests with zero cloud credentials, and our full PR checklist, please read **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

### 🎯 Issue Difficulty Labels

We label open issues by difficulty so you can immediately find work suited to your experience:

- 🟢 **[`level1`](./CONTRIBUTING.md#🟢-level1-beginner--good-first-issue)** (**Beginner / Good First Issue**): Isolated bug fixes, documentation, styling, accessibility contrast, and unit tests (1–2 files).  
  _Examples_: Severity badge contrast ratios, `--no-color` CLI support, snapshot tests.  
  👉 [Browse `level1` issues](https://github.com/GauravKarakoti/SecureFlow/labels/level1)
- 🟡 **[`level2`](./CONTRIBUTING.md#🟡-level2-intermediate--feature-enhancement)** (**Intermediate / Feature Enhancement**): CLI subcommands, UI components, state synchronization, and database migrations (3–6 files).  
  _Examples_: Interactive `secureflow init` command, `--since REF` diff scanning, Dark mode toggle, side-by-side code viewer.  
  👉 [Browse `level2` issues](https://github.com/GauravKarakoti/SecureFlow/labels/level2)
- 🔴 **[`level3`](./CONTRIBUTING.md#🔴-level3-advanced--architectural-work)** (**Advanced / Architectural Work**): Core scanning engines, BullMQ queue workers, LLM orchestration, and cryptography (7+ files).  
  _Examples_: Configurable AI model providers, DLQ auto-retries, HMAC audit trail chain, k6 load testing.  
  👉 [Browse `level3` issues](https://github.com/GauravKarakoti/SecureFlow/labels/level3)

> 📖 **Full Details & Matrix**: See the **[Issue Difficulty Comparison Matrix in CONTRIBUTING.md](./CONTRIBUTING.md#🎯-issue-difficulty-labels-level1-level2-level3)** for detailed expectations and guidelines.

### Branch Naming Conventions

Create a branch from `main` following the `<type>/<description>` format:

```bash
git checkout -b fix/your-issue-name   # bug fix
git checkout -b feat/your-feature     # new feature
git checkout -b docs/update-readme    # documentation
git checkout -b test/add-unit-tests   # testing
```

### Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages:

```bash
git commit -m "fix: description of what you fixed"
git commit -m "feat(cli): description of new feature"
git commit -m "docs: description of documentation change"
```

---

## ❓ FAQ

**How does SecureFlow protect my secrets?**
SecureFlow uses AI to detect hardcoded secrets and sensitive data in your code. It's designed to catch API keys, passwords, tokens, and other credentials that might accidentally be committed to your repository.

**Can I customize the scanning rules?**
Yes! You can create, toggle, and manage custom policies through the dashboard. This allows you to enforce organization-specific security rules.

**Is my data sent to external services?**
Your code diffs are sent to Groq's LLM service for analysis. We do not store your code or share it with third parties. The service is compliant with data protection standards.

**How much does it cost to use SecureFlow?**
SecureFlow is open-source and free to self-host. You'll need a Groq API key (free tier available) and your own PostgreSQL database.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

---

<div align="center">

**Built with ❤️ to make every Pull Request safer.**

_"The vault is empty. Zero traces left behind." — every clean audit, thanks to The Professor._

**⭐ Star us on GitHub — it helps!**

[Report Bug](https://github.com/GauravKarakoti/SecureFlow/issues) · [Request Feature](https://github.com/GauravKarakoti/SecureFlow/issues) · [View Demo](https://secure-flow-six.vercel.app/)

</div>
