#!/usr/bin/env bash
set -e

echo "🚀 Initializing SecureFlow Dev Container..."

# 1. Set up safe local environment configuration
if [ ! -f .env ]; then
  echo "📋 Creating .env from .env.example with safe local defaults..."
  cp .env.example .env
  sed -i 's|^DATABASE_URL=.*|DATABASE_URL="postgresql://secureflow:secureflow@db:5432/secureflow?schema=public"|' .env
  sed -i 's|^DATABASE_POOL_URL=.*|DATABASE_POOL_URL="postgresql://secureflow:secureflow@db:5432/secureflow?schema=public"|' .env
  sed -i 's|^REDIS_URL=.*|REDIS_URL="redis://redis:6379"|' .env
  sed -i 's|^AUTH_SECRET=.*|AUTH_SECRET="devcontainer-insecure-auth-secret-for-local-dev-only-32bytes"|' .env
  sed -i 's|^AUTH_URL=.*|AUTH_URL="http://localhost:9002"|' .env
  sed -i 's|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL="http://localhost:9002"|' .env
  sed -i 's|^GROQ_API_KEY=.*|GROQ_API_KEY="test-key"|' .env
  sed -i 's|^NEXT_PUBLIC_MOCK_AUTH=.*|NEXT_PUBLIC_MOCK_AUTH="true"|' .env
  sed -i 's|^ALLOW_MOCK_AUTH=.*|ALLOW_MOCK_AUTH="true"|' .env
fi

# 2. Install workspace dependencies
echo "📦 Running npm ci..."
npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# 3. Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
  if npx prisma db execute --stdin <<< "SELECT 1;" >/dev/null 2>&1; then
    echo "✅ Database connection established."
    break
  fi
  sleep 2
done

# 4. Generate Prisma client & apply database migrations
echo "🗄️ Applying database migrations..."
npx prisma generate
npx prisma migrate deploy || npx prisma db push

echo "🎉 SecureFlow Dev Container setup is complete!"
echo "👉 Run 'npm run dev' to launch the web dashboard at http://localhost:9002"
