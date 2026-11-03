#!/bin/sh
set -e

# Brings the database schema up to date, sets up a fresh database on the
# first start, adds any new permissions/roles, then starts the API.
# `prisma db push` refuses changes that would lose data, so a risky schema
# change stops the start-up instead of silently dropping columns.
echo "[start] Preparing schema additions"
npx prisma db execute --file prisma/pre-push.sql --schema prisma/schema.prisma

echo "[start] Currency precision upgrade"
npx prisma db execute --file prisma/additions/20261030-regional-money.sql --schema prisma/schema.prisma

npx prisma db execute --file prisma/additions/20261030-offline-settings.sql --schema prisma/schema.prisma

echo "[start] Applying database schema"
npx prisma db push --skip-generate

echo "[start] Database rules"
npx prisma db execute --file prisma/additions/20261102-branch-menu.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/post-push.sql --schema prisma/schema.prisma

echo "[start] Branch ownership and durable sync rules"
npx prisma db execute --file prisma/additions/20261026-branch-runtime.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261026-branch-ownership.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261026-branch-replica.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261027-branch-sync-safety.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261027-branch-media.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261027-branch-payments.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261027-branch-wallets.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/additions/20261027-branch-transfers.sql --schema prisma/schema.prisma

echo "[start] First-run setup"
node prisma/init.js

echo "[start] Checking chart of accounts"
node prisma/normalize-accounts.js

echo "[start] Syncing permissions"
node prisma/sync-permissions.js

echo "[start] Starting API"
exec node dist/index.js
