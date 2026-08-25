# 🗄️ Database & Prisma Documentation

This directory contains the database layer for **SecureFlow**, including the Prisma schema definition, database migration history, and database seeding scripts.

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Database Schema Structure (`schema.prisma`)](#-database-schema-structure-schemaprisma)
  - [1. Identity & Authentication](#1-identity--authentication)
  - [2. Core Domain & Security Analysis](#2-core-domain--security-analysis)
  - [3. Policy Engine & Rules](#3-policy-engine--rules)
  - [4. Audit & Webhook Observability](#4-audit--webhook-observability)
  - [5. Role-Based Access Control (RBAC)](#5-role-based-access-control-rbac)
- [Database Seeding (`seed.ts`)](#-database-seeding-seedts)
- [Developer Migration Workflow](#-developer-migration-workflow)
  - [Prerequisites & Environment Variables](#prerequisites--environment-variables)
  - [1. Generate Prisma Client](#1-generate-prisma-client)
  - [2. Create and Apply Migrations (Local Dev)](#2-create-and-apply-migrations-local-dev)
  - [3. Apply Migrations in Production / CI](#3-apply-migrations-in-production--ci)
  - [4. Schema Prototyping (Without Migrations)](#4-schema-prototyping-without-migrations)
  - [5. Visual Database Management (Prisma Studio)](#5-visual-database-management-prisma-studio)
  - [6. Migration Troubleshooting & Drift Resolution](#6-migration-troubleshooting--drift-resolution)
- [Migration Best Practices](#-migration-best-practices)

---

## 🚀 Overview

SecureFlow uses **PostgreSQL** as its relational database provider and **Prisma ORM** for type-safe schema modeling, query generation, and automated migration management.

```
prisma/
├── migrations/          # Chronological SQL migrations and lock file
│   ├── 20260617164442/  # Initial schema setup
│   ├── ...              # Historical feature migrations
│   ├── 20260727100838/  # Recent schema evolutions
│   ├── migration_lock.toml
│   └── README.md        # Migration folder guidelines
├── schema.prisma        # Canonical database schema & models
├── seed.ts              # Database seeding script (roles & policy templates)
└── README.md            # Database architecture & developer guide
```

---

## 📊 Database Schema Structure (`schema.prisma`)

The database schema in [`schema.prisma`](./schema.prisma) is organized into logical domain modules:

### 1. Identity & Authentication
Compliant with NextAuth.js / Auth.js standard data models with custom SecureFlow attributes:
- **`User`**: Application users, including GitHub profile metadata (`githubLogin`), gamification codenames (`codename`), email, and relation associations.
- **`Account`**: OAuth provider credentials and access tokens linked to user accounts.
- **`Session`**: Active user sessions and expiration timestamps.
- **`VerificationToken`**: Passwordless or email verification tokens.

### 2. Core Domain & Security Analysis
Tracks monitored repositories, pull requests, automated security scans, and persistent finding triage states:
- **`Repository`**: Monitored GitHub repositories (`githubId`, `fullName`, `owner`, `isActive`, `userId`).
- **`PullRequest`**: Scanned pull requests with statuses (`PASS`, `REVIEW_REQUIRED`, `BLOCKED`) and author metadata.
- **`ScanResult`**: Individual scan executions linked to a pull request with overall `riskScore` and `policyDecision`.
- **`Finding`**: Specific security vulnerabilities, secret leaks, or misconfigurations detected during a scan. Contains `promptInjectionSuspected` flag and a stable content hash `fingerprint`.
- **`FindingTriage`**: Triage and lifecycle states (`OPEN`, `RESOLVED`, `FALSE_POSITIVE`, `IGNORED`) keyed by `(repositoryId, fingerprint)`. Ensures developer dismissals survive re-scans.

### 3. Policy Engine & Rules
Provides configurable compliance guardrails:
- **`PolicyTemplate`**: Built-in and custom security policy definitions (`name`, `severity`, `action`, `rules` JSON conditions, `isDefault`).
- **`UserPolicyToggle`**: User-specific activation toggles for individual policy templates.

### 4. Audit & Webhook Observability
Enterprise-grade activity auditing and event provenance:
- **`AuditLog`**: Tamper-evident records of user actions (`action`, `resource`, `decision`, `metadata` JSON, `timestamp`).
- **`WebhookEvent`**: GitHub webhook delivery logs tracking `deliveryId` to prevent duplicate processing and guarantee idempotent ingestion.

### 5. Role-Based Access Control (RBAC)
Granular administrative and auditor permission enforcement:
- **`Role`**: Named user roles (e.g., `ADMIN`, `USER`, `AUDITOR`).
- **`Permission`**: Specific action privileges (e.g., `read:audit`, `delete:user`).
- **`UserRole`**: Junction table mapping users to roles.
- **`RolePermission`**: Junction table mapping roles to permissions.

---

## 🌱 Database Seeding (`seed.ts`)

The [`seed.ts`](./seed.ts) script initializes the database with baseline entities required for development and testing:

1. **System Roles**: Upserts `ADMIN` and `USER` roles.
2. **Comprehensive Policy Templates**: Seeds default and opt-in policies across 12 security categories:
   - Database & SQL (Parameterized Queries)
   - Data Privacy & Compliance (PII Logging Prevention)
   - API & Web Security (SSRF, CORS, Insecure Deserialization)
   - Cryptography (Weak Hashing Deprecation)
   - Infrastructure as Code (Public S3/GCS Denial, Root Container Prevention)
   - Web3 & Smart Contracts (Reentrancy Guards)
   - Credential Management (Non-Expiring Token Detection)
   - Authentication & Access Control (MFA Enforcement, Route Auth Checks, Least-Privilege IAM)
   - Software Supply Chain (Known CVEs, Unpinned Docker Images)
   - Client-Side & Frontend Security (Unsafe DOM XSS Prevention, CSP Header Enforcement)
   - Network & Transport Security (Plaintext HTTP Blockers)
   - Audit & Compliance Logging (Privileged Action Audit Trail Enforcement)

### Running the Seed Script

```bash
# Using npm script shortcut:
npm run db:seed

# Or using Prisma CLI directly:
npx prisma db seed
```

---

## 🛠️ Developer Migration Workflow

### Prerequisites & Environment Variables

Ensure your `.env` or `.env.local` file defines a valid PostgreSQL connection string:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/secureflow?schema=public"
# If using connection pooling (e.g., Supabase / PgBouncer):
DIRECT_URL="postgresql://user:password@localhost:5432/secureflow?schema=public"
```

---

### 1. Generate Prisma Client

Whenever you modify `schema.prisma`, update dependencies, or pull fresh code, regenerate the type-safe client:

```bash
# Shortcut:
npm run db:gen

# Direct command:
npx prisma generate
```

---

### 2. Create and Apply Migrations (Local Dev)

When you make changes to `prisma/schema.prisma` in your local development environment:

```bash
# Generate a new SQL migration and immediately apply it to your local DB:
npx prisma migrate dev --name <descriptive_migration_name>

# Example:
npx prisma migrate dev --name add_prompt_injection_flags
```

This will:
1. Compare `schema.prisma` against existing migrations in `prisma/migrations/`.
2. Generate a new timestamped migration directory (`prisma/migrations/<timestamp>_<name>/migration.sql`).
3. Execute the SQL against your local PostgreSQL database.
4. Automatically regenerate Prisma Client types.

---

### 3. Apply Migrations in Production / CI

In staging, production, or automated deployment pipelines (e.g., Docker builds, Render, Vercel), migrations should be applied without creating new migration files:

```bash
npx prisma migrate deploy
```

> ⚠️ **Note**: `prisma migrate deploy` executes all pending migrations without prompting and should be run during release stages.

---

### 4. Schema Prototyping (Without Migrations)

For rapid local prototyping where you want to sync your database without creating permanent migration files:

```bash
# Shortcut:
npm run db:push

# Direct command:
npx prisma db push
```

---

### 5. Visual Database Management (Prisma Studio)

To view, filter, and modify records in your browser via Prisma's graphical interface:

```bash
npx prisma studio
```

Opens at `http://localhost:5555`.

---

### 6. Migration Troubleshooting & Drift Resolution

If your local database schema gets out of sync or encounters drift:

- **Check migration status**:
  ```bash
  npx prisma migrate status
  ```
- **Mark a failed migration as resolved / rolled back**:
  ```bash
  npx prisma migrate resolve --rolled-back <migration_folder_name>
  # or mark as applied:
  npx prisma migrate resolve --applied <migration_folder_name>
  ```
- **Reset local development database (⚠️ Wipes all data)**:
  ```bash
  npx prisma migrate reset
  ```
  *(Drops the schema, runs all migrations from scratch, and executes `seed.ts` automatically).*

---

## 📌 Migration Best Practices

1. **Descriptive Migration Names**: Use clear, lowercase names with underscores (e.g., `add_finding_fingerprint`, `enforce_rbac_relations`).
2. **Review Generated SQL**: Always inspect the generated `migration.sql` file before committing to ensure no unintended tables or columns are dropped.
3. **Safe Column Alterations**:
   - When adding non-nullable fields to existing tables, provide a default value (e.g., `@default(...)`) to prevent migration failures on populated tables.
   - For column renames or table restructuring, use multi-step deployments (add new column -> backfill data -> switch code -> drop old column) to ensure zero downtime.
4. **Do Not Manually Edit Past Migrations**: Historical migration files already deployed to production must remain immutable. Always create a new migration for schema changes.
5. **Commit Migration Lock File**: Always commit `prisma/migrations/migration_lock.toml` to version control alongside the migration folders.
