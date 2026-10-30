-- Runs before `prisma db push` on every start (docker-entrypoint.sh).
--
-- `db push` refuses to add a unique constraint to a table that already has
-- rows ("might be data loss") and the start-up stops. For new, all-NULL
-- columns that is safe (PostgreSQL allows any number of NULLs under a unique
-- index), so they are created here first, with Prisma's own names, and
-- `db push` then finds nothing to do for them.
--
-- Idempotent, and a no-op on a fresh database (the tables do not exist yet).
-- Only ever add statements for brand-new nullable columns here.
DO $$
BEGIN
  -- Phase 3: a POS PIN identifies exactly one manager per organization
  IF to_regclass('public."User"') IS NOT NULL THEN
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "posPinLookup" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "User_organizationId_posPinLookup_key" ON "User"("organizationId", "posPinLookup");
  END IF;
  -- Phase 4: order-ready screen link per branch
  IF to_regclass('public."Branch"') IS NOT NULL THEN
    ALTER TABLE "Branch" ADD COLUMN IF NOT EXISTS "readyDisplayToken" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "Branch_readyDisplayToken_key" ON "Branch"("readyDisplayToken");
  END IF;
  -- Phase 7: one call-centre order per intake request ID (idempotent retries)
  IF to_regclass('public."CustomerOrder"') IS NOT NULL THEN
    ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS "intakeRequestId" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "CustomerOrder_organizationId_intakeRequestId_key" ON "CustomerOrder"("organizationId", "intakeRequestId");
  END IF;
  -- rider login: one user account per rider
  IF to_regclass('public."Rider"') IS NOT NULL THEN
    ALTER TABLE "Rider" ADD COLUMN IF NOT EXISTS "userId" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "Rider_userId_key" ON "Rider"("userId");
  END IF;
END $$;

-- Counter-level EGS registration: preserves every legacy device and its chain.
DO $$
BEGIN
  IF to_regclass('public."ZatcaDevice"') IS NOT NULL THEN
    ALTER TABLE "ZatcaDevice" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
    CREATE UNIQUE INDEX IF NOT EXISTS "ZatcaDevice_branchId_counterCode_key" ON "ZatcaDevice"("branchId", "counterCode");
    DROP INDEX IF EXISTS "ZatcaDevice_branchId_key";
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."CustomerOrder"') IS NOT NULL THEN
    ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
  END IF;
  IF to_regclass('public."OrderCheck"') IS NOT NULL THEN
    ALTER TABLE "OrderCheck" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
  END IF;
  IF to_regclass('public."PaymentIntent"') IS NOT NULL THEN
    ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "counterCode" TEXT NOT NULL DEFAULT 'main';
    ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "checkoutUrl" TEXT;
  END IF;
END $$;

-- Organization-wide sidebar visibility; preserves all existing data and access.
DO $$
BEGIN
  IF to_regclass('public."Organization"') IS NOT NULL THEN
    ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "hiddenNavigation" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
  END IF;
END $$;

-- Branch PCs (multi-writer numbering). Not a new nullable column, so it is
-- documented separately: order numbers become unique per branch instead of
-- per organization. Each branch has exactly one writer (the cloud or its
-- enrolled PC), so per-branch uniqueness is what prevents collisions. The new
-- index is created first; existing rows already satisfy it because they are
-- unique per organization. Dropping the old index removes no data. Each PC
-- also gets a number series for string document numbers and typed codes.
DO $$
BEGIN
  IF to_regclass('public."CustomerOrder"') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "CustomerOrder_organizationId_branchId_orderNo_key" ON "CustomerOrder"("organizationId", "branchId", "orderNo");
    DROP INDEX IF EXISTS "CustomerOrder_organizationId_orderNo_key";
  END IF;
  IF to_regclass('public."BranchSyncNode"') IS NOT NULL THEN
    ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "numberSeries" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "BranchSyncNode_organizationId_numberSeries_key" ON "BranchSyncNode"("organizationId", "numberSeries");
  END IF;
  IF to_regclass('public."BranchRuntime"') IS NOT NULL THEN
    ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "numberSeries" TEXT;
  END IF;
END $$;
