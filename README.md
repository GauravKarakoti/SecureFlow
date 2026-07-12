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

> *"In this heist, we're not stealing — we're protecting."*
> **SecureFlow automatically detects vulnerabilities, hardcoded secrets, and code flaws before they reach production.**

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
- [🤝 Contributing](#-contributing)
- [❓ FAQ](#-faq)
- [📄 License](#-license)

</details>

---

SecureFlow integrates directly with GitHub via a GitHub App and webhooks. Every time a Pull Request is opened or updated, **The Professor** — SecureFlow's AI mastermind — extracts the code diff, runs it through Groq's LLM (Llama 3.1), and returns actionable security findings with AI-written explanations and remediation steps, all visible on a centralized Mission Control dashboard.

Think of every Pull Request as a member of the crew trying to get into **The Vault** (your codebase). The Professor checks their credentials at the door — no leaked keys, no sloppy code, no breaches on his watch.

## 🌟 The Crew's Abilities (Features)

### 🤖 AI-Powered Detection
Uses Groq's Llama 3.1 to detect hardcoded secrets, vulnerabilities, and misconfigurations in your code.

### ⚡ Real-time Scanning
Automatically scans every opened or updated Pull Request as soon as it's created — The Professor never sleeps.

### 🛡️ Smart Remediation
Generates precise explanations and concrete code fixes for each security finding.

### 📊 Mission Control Dashboard
View all your repositories, PRs, findings, and audit logs in one unified command center.

### 💬 GitHub PR Comments
Posts detailed security reports directly on your PRs with collapsible remediation blocks.

### ✅ GitHub Check Runs
Sets Pass/Review Required/Blocked status on PR commits for clear CI/CD integration.

### 🎯 Custom Policies
Create, toggle, and manage security policies per user or organization — write your own rules for the plan.

### 🚫 Smart Exclusions
Intelligently ignores non-executable files and mock placeholders to reduce noise.

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

| Category | Examples |
|----------|----------|
| 🔑 **Hardcoded Secrets** | API keys, passwords, tokens committed in code |
| 📤 **Contextual Leaks** | `console.log(process.env)`, logging sensitive objects |
| ⚙️ **Misconfigurations** | Wildcard CORS, disabled auth, insecure headers |
| 🧱 **Code Vulnerabilities** | SQL injection patterns, unsafe deserialization |
| ☁️ **IaC Issues** | Public S3 buckets, root container execution |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | [Next.js 15](https://nextjs.org/) - App Router + Turbopack |
| **Database** | PostgreSQL + [Prisma ORM](https://www.prisma.io/) |
| **Authentication** | [NextAuth.js v5](https://authjs.dev/) with GitHub OAuth |
| **AI / LLM** | [Groq SDK](https://groq.com/) (`llama-3.1-8b-instant`) + [Genkit](https://firebase.google.com/docs/genkit) |
| **GitHub Integration** | [Octokit](https://github.com/octokit/octokit.js) |
| **UI** | [Tailwind CSS](https://tailwindcss.com/) + [Radix UI](https://www.radix-ui.com/) + [Recharts](https://recharts.org/) |

---

## 📁 Project Structure

```
secureflow/
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

**Option A — Local PostgreSQL:**
```sql
-- In psql or pgAdmin:
CREATE DATABASE secureflow;
```
Then set `DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/secureflow"` in `.env`

**Option B — Free Cloud DB (easier):**
- Sign up at [neon.tech](https://neon.tech) or [supabase.com](https://supabase.com)
- Create a new project and copy the connection string directly into `DATABASE_URL`

**Then run:**
- Generate Prisma Client
```bash
npm run db:gen
```
- Apply migrations (creates all tables)
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

---

## 🔑 Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `GROQ_API_KEY` | ✅ | API key from [console.groq.com](https://console.groq.com) |
| `GITHUB_APP_ID` | ✅ | Numeric ID of your GitHub App |
| `GITHUB_WEBHOOK_SECRET` | ✅ | Secret used to verify webhook payloads |
| `GITHUB_PRIVATE_KEY` | ✅ | RSA private key from your GitHub App (`.pem` contents) |
| `GITHUB_APP_URL` | ✅ | Public URL of your GitHub App (e.g. `https://github.com/apps/your-app`) |
| `GITHUB_CLIENT_ID` | ✅ | OAuth Client ID for GitHub login |
| `GITHUB_CLIENT_SECRET` | ✅ | OAuth Client Secret for GitHub login |
| `AUTH_SECRET` | ✅ | Random secret for NextAuth session encryption — generate with `openssl rand -base64 32` |
| `ARMORIQ_API_KEY` | ⬜ | Optional — ArmorIQ SDK key for advanced policy features |
| `USER_ID` | ⬜ | Optional — ArmorIQ user ID |
| `AGENT_ID` | ⬜ | Optional — ArmorIQ agent ID |

---

## 📝 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server on port 9002 with Turbopack |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript compiler checks |
| `npm run db:gen` | Generate Prisma Client |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:push` | Push schema to DB without migrations |
| `npm run db:seed` | Seed default policy templates |
| `npm run genkit:dev` | Start Genkit AI development environment |

---

## 🔒 Defense Strategy (Security Policies)

SecureFlow ships with pre-built policy templates that are seeded into the database. Users can toggle them on/off from the dashboard — think of it as briefing the crew before every job.

| Policy | Severity | Default |
|--------|----------|---------|
| Enforce Parameterized Queries | HIGH | ✅ On |
| Prevent PII Logging | CRITICAL | Off |
| Block Internal Network Requests (SSRF) | HIGH | Off |
| Enforce Strict CORS Policies | MEDIUM | Off |
| Prevent Unsafe Deserialization | CRITICAL | Off |
| Deprecate Weak Hashing Algorithms | HIGH | Off |
| Deny Public Cloud Storage | CRITICAL | Off |
| Prevent Root Execution in Containers | MEDIUM | Off |
| Enforce Smart Contract Reentrancy Guards | CRITICAL | Off |

---

## 📊 Architecture

The architecture follows a modern Next.js full-stack approach with real-time GitHub integration:

- **Frontend**: Next.js App Router with Tailwind CSS for the Mission Control dashboard
- **Backend**: API routes handle authentication, webhooks, and business logic
- **AI Layer**: Groq SDK processes code diffs through Llama 3.1 model — The Professor's brain
- **Database**: PostgreSQL with Prisma ORM for data persistence — the Vault Logs
- **GitHub Integration**: Octokit manages webhooks, PR comments, and checks

---

## 🤝 Contributing

Every good heist needs a crew. Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on branching, commit messages, and the PR process.

```bash
# Create a branch following the naming convention


git checkout -b fix/your-issue-name   # bug fix

git checkout -b feat/your-feature     # new feature

git checkout -b docs/update-readme    # documentation
```

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:

```bash
git commit -m "fix: description of what you fixed"

git commit -m "feat: description of new feature"

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

<div align="center">

**Built with ❤️ to make every Pull Request safer.**

*"The vault is empty. Zero traces left behind." — every clean audit, thanks to The Professor.*

**⭐ Star us on GitHub — it helps!**

[Report Bug](https://github.com/GauravKarakoti/SecureFlow/issues) · [Request Feature](https://github.com/GauravKarakoti/SecureFlow/issues) · [View Demo](https://secure-flow-six.vercel.app/)

</div>