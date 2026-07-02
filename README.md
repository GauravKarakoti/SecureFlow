# SecureFlow 🛡️

> AI-powered GitHub Pull Request security scanner that automatically detects vulnerabilities, hardcoded secrets, and code flaws — before they reach production.

SecureFlow integrates directly with GitHub via a GitHub App and webhooks. Every time a Pull Request is opened or updated, it extracts the code diff, runs it through Groq's LLM (Llama 3.1), and generates actionable security findings with AI-written explanations and remediation steps — all visible on a centralized dashboard.

---

## 📋 Table of Contents

- [Features](#-features)
- [How It Works](#-how-it-works)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Fork & Clone](#1-fork--clone)
  - [2. Environment Variables](#2-environment-variables)
  - [3. GitHub App Setup](#3-github-app-setup)
  - [4. Database Setup](#4-database-setup)
  - [5. Run the App](#5-run-the-app)
- [Environment Variables Reference](#-environment-variables-reference)
- [Available Scripts](#-available-scripts)
- [Security Policies](#-security-policies)
- [Contributing](#-contributing)

---

## ✨ Features

- **Automated PR Scanning** — Listens to GitHub webhook events and scans every opened or updated Pull Request in real-time
- **AI-Powered Detection** — Uses Groq's fast LLM inference (Llama 3.1) to detect hardcoded secrets, contextual data leaks (e.g. logging `process.env`), and misconfigurations
- **Intelligent Remediation** — Generates a precise 2-sentence explanation and a concrete code fix for every finding
- **Custom Policy Management** — Create, toggle, and manage security policies per user (e.g. block raw SQL, deny public cloud storage, enforce CORS)
- **Centralized Dashboard** — View repositories, active PRs, scan results, findings, and a full audit log in one place
- **GitHub PR Comments** — Posts a detailed security report directly on the PR with collapsible remediation blocks
- **GitHub Check Runs** — Sets a Pass / Review Required / Blocked status on the PR commit
- **Smart Exclusions** — Ignores non-executable files (`.md`, `.lock`, images) and mock placeholders in seed files and `.env.example`

---

## 🧠 How It Works

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
For each finding → AI generates explanation + remediation steps
              ↓
Findings saved to PostgreSQL via Prisma
              ↓
Results posted as a GitHub PR comment + commit check status
              ↓
Everything visible on the SecureFlow Dashboard
```

### What Gets Detected

| Category | Examples |
|---|---|
| 🔑 Hardcoded Secrets | API keys, passwords, tokens committed in code |
| 📤 Contextual Leaks | `console.log(process.env)`, logging sensitive objects |
| ⚙️ Misconfigurations | Wildcard CORS, disabled auth, insecure headers |
| 🧱 Code Vulnerabilities | SQL injection patterns, unsafe deserialization |
| ☁️ IaC Issues | Public S3 buckets, root container execution |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 15](https://nextjs.org/) — App Router + Turbopack |
| Database | PostgreSQL + [Prisma ORM](https://www.prisma.io/) |
| Authentication | [NextAuth.js v5](https://authjs.dev/) with GitHub OAuth |
| AI / LLM | [Groq SDK](https://groq.com/) (`llama-3.1-8b-instant`) + [Genkit](https://firebase.google.com/docs/genkit) |
| GitHub Integration | [Octokit](https://github.com/octokit/octokit.js) |
| UI | [Tailwind CSS](https://tailwindcss.com/) + [Radix UI](https://www.radix-ui.com/) + [Recharts](https://recharts.org/) |

---

## 📁 Project Structure

```
secureflow/
├── prisma/
│   ├── migrations/         # Database migration history
│   ├── schema.prisma       # Database schema (User, Repo, PR, Finding, etc.)
│   └── seed.ts             # Seeds default security policy templates
│
├── src/
│   ├── ai/
│   │   └── flows/
│   │       └── developer-receives-ai-security-explanations.ts  # Genkit AI flow
│   │
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/           # NextAuth route handler
│   │   │   └── webhooks/
│   │   │       └── github/
│   │   │           └── route.ts  # ← Main webhook handler (PR scanning logic)
│   │   │
│   │   ├── dashboard/
│   │   │   ├── audit/          # Audit log page
│   │   │   ├── findings/       # Security findings page
│   │   │   ├── policies/       # Policy management page
│   │   │   └── page.tsx        # Main dashboard overview
│   │   │
│   │   ├── login/              # Login page
│   │   └── setup/              # GitHub App installation setup page
│   │
│   ├── components/
│   │   ├── ui/                 # Radix UI + shadcn components
│   │   └── dashboard-nav.tsx   # Sidebar navigation
│   │
│   └── lib/
│       ├── armor/
│       │   ├── scanner.ts      # ArmorIQScanner — core LLM scanning engine
│       │   └── iq.ts           # ArmorIQ policy engine + evaluation logic
│       └── prisma.ts           # Prisma client singleton
```

---

## 🚀 Getting Started

### Prerequisites

Make sure you have the following installed and ready:

- [Node.js v20+](https://nodejs.org/)
- [PostgreSQL](https://www.postgresql.org/) (local) or a free cloud DB ([Neon](https://neon.tech) / [Supabase](https://supabase.com))
- A [Groq API Key](https://console.groq.com/) (free tier available)
- A GitHub Account to create a GitHub App

---

### 1. Fork & Clone

```bash
# Fork the repo on GitHub first, then:
git clone https://github.com/YOUR_USERNAME/secureflow.git
cd secureflow
npm install
```

---

### 2. Environment Variables

```bash
cp .env.example .env
```

Then fill in your `.env` file. See the [Environment Variables Reference](#-environment-variables-reference) section below for details on each value.

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
```bash
# Generate Prisma Client
npm run db:gen

# Apply migrations (creates all tables)
npm run db:migrate

# Seed default security policy templates
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
- Open a Pull Request on any linked repo to trigger a scan

**Optional — Genkit AI dev environment** (for working on AI explanation flows):
```bash
npm run genkit:dev
```

---

## 🔑 Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
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
|---|---|
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

## 🔒 Security Policies

SecureFlow ships with pre-built policy templates that are seeded into the database. Users can toggle them on/off from the dashboard.

| Policy | Severity | Default |
|---|---|---|
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

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on branching, commit messages, and the PR process.

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

<div align="center">
  Built with ❤️ to make every Pull Request safer.
</div>
