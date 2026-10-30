-- Bank reconciliation (2026-10). Add-only and idempotent: safe to run more
-- than once, never drops anything. Use this instead of `prisma db push` when
-- the database holds tables/columns this schema doesn't know about.
--   npx prisma db execute --file prisma/sql/2026-10-bank-reconciliation.sql --schema prisma/schema.prisma

CREATE TABLE IF NOT EXISTS "BankStatementLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "importBatch" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2),
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "matchedAt" TIMESTAMP(3),
    "matchedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BankStatementLine_bankAccountId_status_idx" ON "BankStatementLine"("bankAccountId", "status");
CREATE INDEX IF NOT EXISTS "BankStatementLine_bankAccountId_date_idx" ON "BankStatementLine"("bankAccountId", "date");

ALTER TABLE "JournalLine" ADD COLUMN IF NOT EXISTS "statementLineId" TEXT;
CREATE INDEX IF NOT EXISTS "JournalLine_statementLineId_idx" ON "JournalLine"("statementLineId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'JournalLine_statementLineId_fkey') THEN
    ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_statementLineId_fkey"
      FOREIGN KEY ("statementLineId") REFERENCES "BankStatementLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BankStatementLine_bankAccountId_fkey') THEN
    ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_bankAccountId_fkey"
      FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
