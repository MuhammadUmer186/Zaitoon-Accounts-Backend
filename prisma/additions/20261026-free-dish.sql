-- Additive Free Dish migration. Run once, or use the existing db push deployment flow.

CREATE TABLE "FreeDishItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeDishItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FreeDishQr" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "publicToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "voucherValidDays" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeDishQr_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FreeDishSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "qrId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "fullName" VARCHAR(120) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "normalizedWhatsApp" TEXT NOT NULL,
    "normalizedEmail" VARCHAR(160) NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "voucherCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedBy" TEXT,
    "itemName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "branchName" TEXT NOT NULL,
    "sectionName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeDishSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FreeDishRateLimit" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeDishRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "FreeDishItem_organizationId_name_key" ON "FreeDishItem"("organizationId", "name");

CREATE UNIQUE INDEX "FreeDishQr_publicToken_key" ON "FreeDishQr"("publicToken");

CREATE INDEX "FreeDishQr_organizationId_branchId_createdAt_idx" ON "FreeDishQr"("organizationId", "branchId", "createdAt");

CREATE UNIQUE INDEX "FreeDishSubmission_voucherCode_key" ON "FreeDishSubmission"("voucherCode");

CREATE INDEX "FreeDishSubmission_organizationId_branchId_createdAt_idx" ON "FreeDishSubmission"("organizationId", "branchId", "createdAt");

CREATE INDEX "FreeDishSubmission_organizationId_status_expiresAt_idx" ON "FreeDishSubmission"("organizationId", "status", "expiresAt");

CREATE UNIQUE INDEX "FreeDishSubmission_qrId_normalizedWhatsApp_key" ON "FreeDishSubmission"("qrId", "normalizedWhatsApp");

CREATE UNIQUE INDEX "FreeDishSubmission_qrId_normalizedEmail_key" ON "FreeDishSubmission"("qrId", "normalizedEmail");

CREATE INDEX "FreeDishRateLimit_expiresAt_idx" ON "FreeDishRateLimit"("expiresAt");

ALTER TABLE "FreeDishItem" ADD CONSTRAINT "FreeDishItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BranchSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishQr" ADD CONSTRAINT "FreeDishQr_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "FreeDishItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishSubmission" ADD CONSTRAINT "FreeDishSubmission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishSubmission" ADD CONSTRAINT "FreeDishSubmission_qrId_fkey" FOREIGN KEY ("qrId") REFERENCES "FreeDishQr"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishSubmission" ADD CONSTRAINT "FreeDishSubmission_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FreeDishSubmission" ADD CONSTRAINT "FreeDishSubmission_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "BranchSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
