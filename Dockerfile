FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY .env.example .env
ENV NODE_ENV=production
RUN npx prisma generate && npx next build

# Isolated, independently-cacheable stage for the Prisma CLI + its migration engine (needed at
# container startup to run `prisma migrate deploy`, distinct from the generated Prisma *client*
# that ships inside .next/standalone). Kept separate from the app's own node_modules so the
# app's runtime dependency tree stays exactly what Next's output tracing produced, and so this
# layer is cached independently of app source changes.
FROM node:20-alpine AS prisma-cli
WORKDIR /opt/prisma-cli
RUN npm init -y && npm install --omit=dev --ignore-scripts --no-audit --no-fund dotenv@16.6.1 prisma@7.8.0

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9002
ENV HOSTNAME=0.0.0.0
ENV NODE_PATH=/opt/prisma-cli/node_modules

# Run as a dedicated non-root user rather than the container default root, so a compromised
# Next.js process doesn't have root inside the container (reduces attack surface per #194).
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=prisma-cli /opt/prisma-cli /opt/prisma-cli
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs

EXPOSE 9002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:9002/ || exit 1

ENTRYPOINT ["sh", "-c", "node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy && node server.js"]