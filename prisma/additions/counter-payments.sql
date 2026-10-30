-- Safe, idempotent upgrade for payment-first kitchen and counter-level EGS.
BEGIN;
ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
ALTER TABLE "OrderCheck" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "checkoutUrl" TEXT;
ALTER TABLE "ZatcaDevice" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
CREATE UNIQUE INDEX IF NOT EXISTS "ZatcaDevice_branchId_counterCode_key" ON "ZatcaDevice"("branchId", "counterCode");
DROP INDEX IF EXISTS "ZatcaDevice_branchId_key";
COMMIT;
