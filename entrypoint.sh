#!/bin/sh
set -e

echo "=== SecureFlow Container Initialization ==="

# -----------------------------------------------------------------------------
# Secret file resolution helper (<NAME>_FILE -> <NAME>) (#1893)
# Resolves mounted secrets (Docker Compose secrets, Docker Swarm, Kubernetes).
# -----------------------------------------------------------------------------
resolve_secret_file() {
  var_name="$1"
  file_var="${var_name}_FILE"

  eval "val=\${$var_name:-}"
  eval "file_path=\${$file_var:-}"

  # If file variable is not set, nothing to resolve
  if [ -z "$file_path" ]; then
    return 0
  fi

  # If both NAME and NAME_FILE are set, fail fast with a clear error
  if [ -n "$val" ]; then
    echo "Error: Cannot specify both $var_name and $file_var. Choose one secret source." >&2
    exit 1
  fi

  # Check that the secret file exists
  if [ ! -f "$file_path" ]; then
    echo "Error: Secret file for $var_name specified in $file_var does not exist: $file_path" >&2
    exit 1
  fi

  # Check that the secret file is readable
  if [ ! -r "$file_path" ]; then
    echo "Error: Secret file for $var_name specified in $file_var is not readable: $file_path" >&2
    exit 1
  fi

  # Read file content and trim a trailing newline
  # $(cat ...) in POSIX shell automatically strips trailing newline(s) while preserving internal newlines.
  resolved_val="$(cat "$file_path")"
  export "$var_name=$resolved_val"
  unset "$file_var"
}

# Resolve known secret variables
KNOWN_SECRET_VARS="DATABASE_URL DATABASE_POOL_URL GROQ_API_KEY GITHUB_WEBHOOK_SECRET GITHUB_PRIVATE_KEY GITHUB_CLIENT_SECRET AUTH_SECRET ARMORIQ_API_KEY ARMORIQ_PROOF_SIGNING_KEY UPSTASH_REDIS_REST_TOKEN ELEVENLABS_API_KEY BREVO_API_KEY SMTP_PASS REDIS_URL"

for var_name in $KNOWN_SECRET_VARS; do
  resolve_secret_file "$var_name"
done

# Also resolve any dynamically defined *_FILE variables in the environment
for file_var in $(env | grep -E '^[A-Za-z0-9_]+_FILE=' | sed 's/=.*//'); do
  var_name="${file_var%_FILE}"
  resolve_secret_file "$var_name"
done

# -----------------------------------------------------------------------------
# Database migration step (#1893)
# Runs Prisma migrations if RUN_MIGRATIONS=true or if requested via args.
# -----------------------------------------------------------------------------
if [ "$RUN_MIGRATIONS" = "true" ] || [ "$1" = "migrate" ]; then
  echo "Running Prisma migrations..."
  if [ -f "/opt/prisma-cli/node_modules/prisma/build/index.js" ]; then
    node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy
  elif command -v npx >/dev/null 2>&1; then
    npx prisma migrate deploy
  else
    echo "Warning: Prisma migration CLI not found, skipping migration step." >&2
  fi

  if [ "$1" = "migrate" ]; then
    echo "Migrations completed successfully."
    exit 0
  fi
fi

# -----------------------------------------------------------------------------
# Execute passed command or start Next.js standalone server
# -----------------------------------------------------------------------------
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "Starting Next.js standalone server..."
exec node server.js
