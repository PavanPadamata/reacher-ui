#!/bin/sh
set -e

echo "Running database migrations..."
node node_modules/prisma/build/index.js db push

echo "Starting Next.js..."
exec node server.js
