require('dotenv/config')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Repairs Chart of Accounts rows written by older versions, which stored the
// class ("asset") and normal balance ("debit") in lower case. The app filters
// and signs balances on the upper-case values, so such accounts were missing
// from the class tabs and reports and showed their balance with the wrong
// sign. Runs on every start; does nothing once the data is clean.

const CLASSES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']
const ALIASES = { ASSETS: 'ASSET', LIABILITIES: 'LIABILITY', INCOME: 'REVENUE', EXPENSES: 'EXPENSE', CAPITAL: 'EQUITY' }
const NORMAL_BALANCE = { ASSET: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT', EXPENSE: 'DEBIT' }

async function main() {
  const accounts = await prisma.account.findMany({ select: { id: true, code: true, accountClass: true, normalBalance: true } })
  let fixed = 0
  for (const a of accounts) {
    const raw = String(a.accountClass ?? '').trim().toUpperCase()
    const accountClass = ALIASES[raw] ?? raw
    if (!CLASSES.includes(accountClass)) {
      console.warn(`[accounts] ${a.code} has an unknown class "${a.accountClass}" — fix it under Chart of Accounts`)
      continue
    }
    const nb = String(a.normalBalance ?? '').trim().toUpperCase()
    const normalBalance = nb === 'DEBIT' || nb === 'CREDIT' ? nb : NORMAL_BALANCE[accountClass]
    if (accountClass !== a.accountClass || normalBalance !== a.normalBalance) {
      await prisma.account.update({ where: { id: a.id }, data: { accountClass, normalBalance } })
      fixed++
    }
  }
  console.log(fixed ? `[accounts] Normalized class / normal balance on ${fixed} account(s)` : '[accounts] Chart of accounts OK')
}

main()
  .catch((err) => {
    console.error('[accounts] normalize failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
