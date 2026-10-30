-- Preserve the existing enabled behavior on upgrade; no queued orders are removed.
DO $$
BEGIN
  IF to_regclass('public."Organization"') IS NOT NULL THEN
    ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "offlinePosEnabled" BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "offlinePosDisabledAt" TIMESTAMP(3);
    ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "offlinePosRevokedAt" TIMESTAMP(3)[] NOT NULL DEFAULT ARRAY[]::TIMESTAMP(3)[];
  END IF;
END $$;
