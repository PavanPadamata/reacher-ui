#!/bin/sh
set -e

echo "Running database migrations..."
./node_modules/.bin/prisma db push

echo "Starting Next.js..."
exec node server.js
