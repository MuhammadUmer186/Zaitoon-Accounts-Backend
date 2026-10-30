-- Additive finance update; no existing data is modified.
CREATE TABLE IF NOT EXISTS "DocumentSequence" (
  "organizationId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "lastNumber" INTEGER NOT NULL,
  CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("organizationId", "model", "field", "prefix", "year")
);

CREATE TABLE IF NOT EXISTS "AccountingMappingAccount" (
  "organizationId" TEXT NOT NULL,
  "key" "AccountingMappingKey" NOT NULL,
  "accountId" TEXT NOT NULL,
  CONSTRAINT "AccountingMappingAccount_pkey" PRIMARY KEY ("organizationId", "key", "accountId")
);
INSERT INTO "AccountingMappingAccount" ("organizationId", "key", "accountId")
SELECT "organizationId", "key", "accountId" FROM "AccountingMapping"
ON CONFLICT DO NOTHING;
