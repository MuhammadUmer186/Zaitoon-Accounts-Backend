import { PrismaClient } from '@prisma/client'

// Accounts created by older versions stored the class ("accountType" column)
// and normal balance in lowercase ("asset", "debit"). Every filter, report and
// balance calculation compares against the uppercase values, so those accounts
// vanished from the Chart of Accounts tabs and financial reports and had their
// balance sign flipped. Runs on every start; only touches rows that need it.
// A valid DEBIT/CREDIT is kept as-is (contra accounts such as accumulated
// depreciation are credit-normal assets); a missing or invalid one is derived
// from the class.
export async function normalizeAccounts(prisma: PrismaClient) {
  try {
    const fixed = await prisma.$executeRawUnsafe(`
      UPDATE "Account"
      SET "accountType" = UPPER(TRIM("accountType")),
          "normalBalance" = CASE
            WHEN UPPER(TRIM("normalBalance")) IN ('DEBIT', 'CREDIT') THEN UPPER(TRIM("normalBalance"))
            WHEN UPPER(TRIM("accountType")) IN ('ASSET', 'EXPENSE') THEN 'DEBIT'
            ELSE 'CREDIT'
          END
      WHERE "accountType" IS DISTINCT FROM UPPER(TRIM("accountType"))
         OR "normalBalance" IS NULL
         OR "normalBalance" NOT IN ('DEBIT', 'CREDIT')
    `)
    if (fixed > 0) console.log(`[accounts] normalized class/normal balance on ${fixed} account(s)`)
  } catch (err) {
    console.error('[accounts] normalization failed:', err)
  }
}
