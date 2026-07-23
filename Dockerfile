# syntax=docker/dockerfile:1.7
# ============================================================================
# SecureFlow — optimized Next.js 16 production image
#
# Multi-stage build leveraging `output: 'standalone'` (see next.config.ts).
# Next.js output tracing produces a self-contained `.next/standalone` bundle
# containing only the modules the app actually imports. The final `runner`
# stage therefore does NOT copy `node_modules` wholesale — only the standalone
# server, static assets, public files, and a tiny Prisma CLI layer for
# `prisma migrate deploy` at startup.
#
# `output: 'standalone'` is enabled conditionally in next.config.ts via the
# DOCKER_BUILD env var (set below in the builder stage). This keeps local
# `npm run dev` / `npm run build` / `npm run start` unaffected.
#
# Stages:
#   1. deps         — install ALL deps (cached on package*.json change only)
#   2. builder      — prisma generate + next build (produces .next/standalone)
#   3. prisma-cli   — isolated Prisma CLI for startup migrations
#   4. runner       — minimal runtime image (non-root, no shell deps beyond wget)
# ============================================================================


# ----------------------------------------------------------------------------
# 1. deps — install node_modules (cached unless package*.json changes)
# ----------------------------------------------------------------------------
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy lockfile + package.json first for maximum layer caching.
COPY package.json package-lock.json* ./

# Copy the prisma schema so the `postinstall: prisma generate` hook can run.
# Without the schema, `prisma generate` is a no-op and the build stage would
# have to regenerate the client, slowing iteration.
COPY prisma ./prisma

# `npm ci` respects the lockfile exactly. The postinstall hook runs
# `prisma generate`, which only needs the schema (copied above).
RUN npm ci --legacy-peer-deps


# ----------------------------------------------------------------------------
# 2. builder — compile the Next.js app and emit the standalone bundle
# ----------------------------------------------------------------------------
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Bring in installed deps from the `deps` stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source.
COPY . .

# Provide a build-time .env so `next build` can inline any
# NEXT_PUBLIC_* vars. Runtime secrets come from the compose env_file.
COPY .env.example .env

# Build-time env. Next.js inlines NEXT_PUBLIC_* at build time, so this
# must be `production` for proper tree-shaking and React production build.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Tell next.config.ts to enable `output: 'standalone'` for this Docker build.
# Without this flag, `output` is omitted and no `.next/standalone` bundle is
# produced — which is the desired behavior for local dev/build/start, but
# would break the runner stage below (it copies from .next/standalone).
ENV DOCKER_BUILD=true

# Generate the Prisma client (in case postinstall didn't, e.g. if the
# schema changed since the deps stage) and then build Next.js.
# With DOCKER_BUILD=true set above, `next build` produces `.next/standalone`.
RUN npx prisma generate && npx next build


# ----------------------------------------------------------------------------
# 3. prisma-cli — isolated, independently-cacheable Prisma CLI layer
#
# Used only at container startup to run `prisma migrate deploy`. Kept
# separate from the app's node_modules so the runtime dependency tree
# stays exactly what Next's output tracing produced, and so this layer
# is cached independently of app source changes.
# ----------------------------------------------------------------------------
FROM node:22-alpine AS prisma-cli
WORKDIR /opt/prisma-cli
RUN npm init -y \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
      dotenv@16.6.1 prisma@7.8.0


# ----------------------------------------------------------------------------
# 4. runner — minimal runtime image
# ----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=9002
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
# Make the isolated prisma CLI resolvable from the runner's NODE_PATH so
# the entrypoint can invoke `prisma migrate deploy` without colliding with
# the standalone bundle's own (minimal) node_modules.
ENV NODE_PATH=/opt/prisma-cli/node_modules

# Dedicated non-root user. A compromised Next.js process should not have
# root inside the container (reduces attack surface per #194).
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# --- Prisma CLI layer (for startup migrations) -----------------------------
COPY --from=prisma-cli /opt/prisma-cli /opt/prisma-cli

# --- Standalone Next.js server ---------------------------------------------
# `.next/standalone` is a self-contained bundle produced by `output: 'standalone'`
# (enabled via DOCKER_BUILD=true in the builder stage above).
# It includes its own minimal node_modules — no need to copy the full tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# Static assets are NOT bundled in standalone — copy them explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Public folder is served as-is by Next.js — also not in standalone.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# --- Prisma schema + migrations (for `migrate deploy` at startup) ----------
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# --- Generated Prisma client runtime artifacts -----------------------------
# `outputFileTracingIncludes` in next.config.ts already pulls
# `node_modules/.prisma/client/**/*` into the standalone bundle, so in
# practice these two copies are belt-and-suspenders for any Prisma version
# that resolves the client outside the traced path. Cheap to keep.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs

EXPOSE 9002

# Liveness probe — Next.js always responds at `/` (200 even without a route,
# because the root layout renders). `wget` is available on alpine by default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:9002/ || exit 1

# Run migrations, then start the standalone server (`node server.js` is the
# entrypoint emitted by `output: 'standalone'`). Using `sh -c` lets us chain
# the two commands; the prisma CLI is found via NODE_PATH above.
ENTRYPOINT ["sh", "-c", "node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy && node server.js"]