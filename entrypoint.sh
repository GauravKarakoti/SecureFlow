#!/bin/sh
set -e

echo "=== SecureFlow Container Initialization ==="
echo "Running Prisma migrations..."
node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy

echo "Starting Next.js standalone server..."
exec node server.js

