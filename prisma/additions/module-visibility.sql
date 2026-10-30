-- Organization-wide sidebar visibility; preserves all existing data and access.
DO $$
BEGIN
  IF to_regclass('public."Organization"') IS NOT NULL THEN
    ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "hiddenNavigation" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
  END IF;
END $$;
