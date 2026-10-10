-- Fixed assets + recurring journals (2026-10). Add-only and idempotent.
--   npx prisma db execute --file prisma/sql/2026-10-fixed-assets-recurring.sql --schema prisma/schema.prisma

CREATE TABLE IF NOT EXISTS "FixedAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "assetNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "inServiceDate" TIMESTAMP(3) NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL,
    "salvageValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "assetAccountId" TEXT NOT NULL,
    "accumulatedDepAccountId" TEXT NOT NULL,
    "depreciationExpenseAccountId" TEXT NOT NULL,
    "accumulatedDepreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disposedAt" TIMESTAMP(3),
    "disposalProceeds" DECIMAL(18,2),
    "disposalJournalEntryId" TEXT,
    "acquisitionJournalEntryId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FixedAssetDepreciation" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedAssetDepreciation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RecurringJournal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "nextRunDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "lines" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringJournal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FixedAsset_organizationId_status_idx" ON "FixedAsset"("organizationId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "FixedAsset_organizationId_assetNo_key" ON "FixedAsset"("organizationId", "assetNo");

CREATE UNIQUE INDEX IF NOT EXISTS "FixedAssetDepreciation_assetId_periodMonth_key" ON "FixedAssetDepreciation"("assetId", "periodMonth");

CREATE INDEX IF NOT EXISTS "RecurringJournal_organizationId_isActive_nextRunDate_idx" ON "RecurringJournal"("organizationId", "isActive", "nextRunDate");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FixedAssetDepreciation_assetId_fkey') THEN
    ALTER TABLE "FixedAssetDepreciation" ADD CONSTRAINT "FixedAssetDepreciation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Column added after the table was first created
ALTER TABLE "RecurringJournal" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
