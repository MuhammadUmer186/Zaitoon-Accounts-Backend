-- Runs after `prisma db push` on every start (docker-entrypoint.sh).
--
-- Database rules Prisma does not manage (CHECK constraints). Idempotent: each
-- is added only when its table exists and the constraint is missing.
DO $$
BEGIN
  -- Phase 6: a gift card can never be spent below zero, whatever the code does
  IF to_regclass('public."GiftCard"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GiftCard_balance_nonnegative') THEN
    ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_balance_nonnegative" CHECK ("balance" >= 0 AND "balance" <= "initialAmount");
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."FreeDishQr"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeDishQr_values_check') THEN
    ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_values_check" CHECK (quantity BETWEEN 1 AND 20 AND ("voucherValidDays" IS NULL OR "voucherValidDays" BETWEEN 1 AND 365));
  END IF;
  IF to_regclass('public."FreeDishSubmission"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeDishSubmission_state_check') THEN
    ALTER TABLE "FreeDishSubmission" ADD CONSTRAINT "FreeDishSubmission_state_check" CHECK (
      quantity BETWEEN 1 AND 20 AND "normalizedEmail" = lower("normalizedEmail") AND
      ((status = 'issued' AND "redeemedAt" IS NULL AND "redeemedBy" IS NULL) OR
       (status = 'redeemed' AND "redeemedAt" IS NOT NULL AND "redeemedBy" IS NOT NULL))
    );
  END IF;
END $$;
