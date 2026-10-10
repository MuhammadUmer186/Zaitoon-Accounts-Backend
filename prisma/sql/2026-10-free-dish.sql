-- Free Dish module (2026-10). Add-only and idempotent.
--   npx prisma db execute --file prisma/sql/2026-10-free-dish.sql --schema prisma/schema.prisma

CREATE TABLE IF NOT EXISTS "FreeDishQr" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offer" TEXT NOT NULL DEFAULT 'Free dish',
    "token" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "voucherValidDays" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeDishQr_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FreeDishSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "qrId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "whatsapp" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "voucherCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedBy" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeDishSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FreeDishQr_token_key" ON "FreeDishQr"("token");

CREATE INDEX IF NOT EXISTS "FreeDishQr_organizationId_idx" ON "FreeDishQr"("organizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "FreeDishSubmission_voucherCode_key" ON "FreeDishSubmission"("voucherCode");

CREATE INDEX IF NOT EXISTS "FreeDishSubmission_organizationId_createdAt_idx" ON "FreeDishSubmission"("organizationId", "createdAt");

CREATE INDEX IF NOT EXISTS "FreeDishSubmission_branchId_status_idx" ON "FreeDishSubmission"("branchId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "FreeDishSubmission_qrId_whatsapp_key" ON "FreeDishSubmission"("qrId", "whatsapp");

CREATE UNIQUE INDEX IF NOT EXISTS "FreeDishSubmission_qrId_email_key" ON "FreeDishSubmission"("qrId", "email");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeDishQr_branchId_fkey') THEN
    ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeDishQr_sectionId_fkey') THEN
    ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BranchSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeDishSubmission_qrId_fkey') THEN
    ALTER TABLE "FreeDishSubmission" ADD CONSTRAINT "FreeDishSubmission_qrId_fkey" FOREIGN KEY ("qrId") REFERENCES "FreeDishQr"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Free items list (which dish a QR code gives away)
CREATE TABLE IF NOT EXISTS "FreeDishItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeDishItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FreeDishItem_organizationId_name_key" ON "FreeDishItem"("organizationId", "name");

ALTER TABLE "FreeDishQr" ADD COLUMN IF NOT EXISTS "itemId" TEXT;
ALTER TABLE "FreeDishQr" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FreeDishQr_itemId_fkey') THEN
    ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "FreeDishItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
