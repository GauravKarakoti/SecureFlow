# Local Development Setup Guide

This guide walks you through acquiring every credential required to run SecureFlow locally.

---

## 1. PostgreSQL / Prisma (`DATABASE_URL`, `DATABASE_POOL_URL`, `DB_POOL_MAX`)

**Option A — Local PostgreSQL**

1. Install [PostgreSQL](https://www.postgresql.org/download/).
2. Create a database:
   ```sql
   CREATE DATABASE secureflow;
   ```
3. Set in `.env`:
   ```env
   DATABASE_URL="postgresql://postgres:<your_password>@localhost:5432/secureflow"
   DATABASE_POOL_URL=""   # leave empty for local dev
   DB_POOL_MAX=10
   ```

**Option B — Neon (recommended for cloud/serverless)**

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. From the **Connection Details** panel, copy:
   - **Direct URL** → `DATABASE_URL`
   - **Pooled URL** → `DATABASE_POOL_URL`
3. Set `DB_POOL_MAX=10` (or adjust based on your plan's connection limit).

After setting the URLs, run:
```bash
npm run db:gen
npm run db:migrate
npm run db:seed
```

---

## 2. Groq SDK (`GROQ_API_KEY`, `GROQ_MODEL`)

1. Sign up at [console.groq.com](https://console.groq.com).
2. Go to **API Keys → Create API Key**.
3. Copy the key → `GROQ_API_KEY`.
4. `GROQ_MODEL` defaults to `llama-3.1-8b-instant`. Change only if you want a different supported model.

```env
GROQ_API_KEY="gsk_..."
GROQ_MODEL="llama-3.1-8b-instant"
```

---

## 3. GitHub App (`GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_APP_URL`)

1. Go to **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **Homepage URL**: `http://localhost:9002`
   - **Webhook URL**: your ngrok URL + `/api/webhooks/github`
     ```bash
     ngrok http 9002   # copy the https:// forwarding URL
     ```
   - **Webhook Secret**: any random string (e.g. `openssl rand -hex 20`) → `GITHUB_WEBHOOK_SECRET`
3. Set **Repository Permissions**: Contents `Read`, Pull Requests `Read & Write`, Checks `Read & Write`.
4. Subscribe to events: `Pull request`, `Installation`, `Installation repositories`.
5. Click **Create GitHub App**, then:
   - Copy **App ID** → `GITHUB_APP_ID`
   - Scroll to **Private Keys → Generate a private key** → download `.pem` → paste its full contents (including headers) into `GITHUB_PRIVATE_KEY`, replacing newlines with `\n`:
     ```bash
     awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-app.pem
     ```
   - Copy the app's public URL → `GITHUB_APP_URL` (e.g. `https://github.com/apps/your-app-name`)

```env
GITHUB_APP_ID="123456"
GITHUB_WEBHOOK_SECRET="your_random_secret"
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_URL="https://github.com/apps/your-app-name"
```

---

## 4. GitHub OAuth / NextAuth (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_URL`)

These power the **Sign in with GitHub** button via NextAuth.js.

1. In the same GitHub App you created above, scroll to **OAuth Credentials**.
2. Copy **Client ID** → `GITHUB_CLIENT_ID`.
3. Click **Generate a new client secret** → `GITHUB_CLIENT_SECRET`.
4. Generate `AUTH_SECRET`:
   ```bash
   openssl rand -base64 32
   ```
5. Set `AUTH_URL` to your local dev URL:
   ```env
   AUTH_URL="http://localhost:9002"
   ```

```env
GITHUB_CLIENT_ID="Iv1.abc123"
GITHUB_CLIENT_SECRET="your_client_secret"
AUTH_SECRET="your_generated_secret"
AUTH_URL="http://localhost:9002"
```

---

## 5. Redis (`REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)

Redis is optional for local development. Leave all three blank if you don't need caching/rate-limiting locally.

**For production or if your feature branch requires it:**

1. Sign up at [upstash.com](https://upstash.com) and create a Redis database.
2. From the database dashboard, copy:
   - **Redis URL** (starts with `rediss://`) → `REDIS_URL`
   - **REST URL** → `UPSTASH_REDIS_REST_URL`
   - **REST Token** → `UPSTASH_REDIS_REST_TOKEN`

```env
REDIS_URL="rediss://default:<token>@<host>:6379"
UPSTASH_REDIS_REST_URL="https://<host>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your_token"
```

---

## 6. ArmorIQ (optional — `ARMORIQ_API_KEY`, `USER_ID`, `AGENT_ID`)

These are only needed for advanced policy features. Leave blank for standard local development.

---

## 7. Workspace Architecture & Dependency Management

SecureFlow is organized as an **npm workspace** monorepo with the root project and the `cli/` workspace (`secureflow-cli`). All dependencies are hoisted and managed under a single source of truth at `package-lock.json` in the project root.

### Common Workspace Commands

- **Install all dependencies across root and workspaces**:
  ```bash
  npm install
  ```
- **Build CLI package via workspace**:
  ```bash
  npm run cli:build
  # or directly with npm workspace:
  npm run build --workspace=cli
  ```
- **Run CLI tests via workspace**:
  ```bash
  npm run cli:test
  # or directly with npm workspace:
  npm run test --workspace=cli
  ```
- **Typecheck CLI workspace**:
  ```bash
  npm run cli:typecheck
  ```

---

## Quick-start checklist

```
[ ] DATABASE_URL set and `npm run db:migrate` succeeded
[ ] GROQ_API_KEY set
[ ] GitHub App created — APP_ID, WEBHOOK_SECRET, PRIVATE_KEY, APP_URL set
[ ] GitHub OAuth credentials set — CLIENT_ID, CLIENT_SECRET
[ ] AUTH_SECRET generated and set
[ ] ngrok running and Webhook URL updated in GitHub App settings
[ ] npm install completed with single root package-lock.json
[ ] npm run dev starts without errors at http://localhost:9002
```

