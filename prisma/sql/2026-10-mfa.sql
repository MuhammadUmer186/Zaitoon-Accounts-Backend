-- Two-factor login (2026-10). Add-only and idempotent.
--   npx prisma db execute --file prisma/sql/2026-10-mfa.sql --schema prisma/schema.prisma
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaLastStep" INTEGER;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "requireAdminMfa" BOOLEAN NOT NULL DEFAULT false;
