// Reference setup every organization needs, shared by the demo seed
// (seed.js) and the first-run initializer (init.js): the standard chart of
// accounts and the posting-role mappings every module resolves through
// (resolveMappedAccount in ledger.ts) — without the mappings no sale,
// expense, bill, wastage or cash closing can post.

const ACCOUNTS = [
  { code: '1000', name: 'Assets', accountClass: 'ASSET', isControlAccount: true, isSystem: true },
  { code: '1100', name: 'Current Assets', accountClass: 'ASSET', isControlAccount: true, isSystem: true, parentCode: '1000' },
  { code: '1110', name: 'Cash on Hand', accountClass: 'ASSET', reportingGroup: 'Cash', parentCode: '1100' },
  { code: '1120', name: 'Bank Accounts', accountClass: 'ASSET', reportingGroup: 'Bank', parentCode: '1100' },
  { code: '1150', name: 'Card Clearing', accountClass: 'ASSET', reportingGroup: 'Bank', parentCode: '1100' },
  { code: '1200', name: 'Accounts Receivable', accountClass: 'ASSET', reportingGroup: 'Accounts Receivable', parentCode: '1100' },
  { code: '1300', name: 'Inventory', accountClass: 'ASSET', reportingGroup: 'Inventory', parentCode: '1100' },
  { code: '1400', name: 'Input VAT', accountClass: 'ASSET', reportingGroup: 'Input VAT', parentCode: '1100' },
  { code: '1500', name: 'Prepayments', accountClass: 'ASSET', reportingGroup: 'Prepayments', parentCode: '1100' },
  { code: '1600', name: 'Fixed Assets', accountClass: 'ASSET', isControlAccount: true, isSystem: true, parentCode: '1000' },
  { code: '1610', name: 'Furniture and Equipment', accountClass: 'ASSET', reportingGroup: 'Fixed Assets', parentCode: '1600' },
  { code: '1620', name: 'Kitchen Equipment', accountClass: 'ASSET', reportingGroup: 'Fixed Assets', parentCode: '1600' },
  { code: '1690', name: 'Accumulated Depreciation', accountClass: 'ASSET', reportingGroup: 'Accumulated Depreciation', parentCode: '1600' },

  { code: '2000', name: 'Liabilities', accountClass: 'LIABILITY', isControlAccount: true, isSystem: true },
  { code: '2100', name: 'Current Liabilities', accountClass: 'LIABILITY', isControlAccount: true, isSystem: true, parentCode: '2000' },
  { code: '2110', name: 'Accounts Payable', accountClass: 'LIABILITY', reportingGroup: 'Accounts Payable', parentCode: '2100' },
  { code: '2200', name: 'Output VAT', accountClass: 'LIABILITY', reportingGroup: 'Output VAT', parentCode: '2100' },
  { code: '2300', name: 'Accrued Expenses', accountClass: 'LIABILITY', reportingGroup: 'Accrued Expenses', parentCode: '2100' },
  { code: '2400', name: 'Loans Payable', accountClass: 'LIABILITY', reportingGroup: 'Loans', parentCode: '2000' },
  { code: '2500', name: 'Other Liabilities', accountClass: 'LIABILITY', reportingGroup: 'Other Liabilities', parentCode: '2000' },

  { code: '3000', name: 'Equity', accountClass: 'EQUITY', isControlAccount: true, isSystem: true },
  { code: '3100', name: 'Owner Capital', accountClass: 'EQUITY', reportingGroup: 'Owner Capital', parentCode: '3000' },
  { code: '3200', name: 'Retained Earnings', accountClass: 'EQUITY', reportingGroup: 'Retained Earnings', parentCode: '3000' },
  { code: '3300', name: 'Current Year Earnings', accountClass: 'EQUITY', reportingGroup: 'Current Year Earnings', parentCode: '3000', isSystem: true, allowManualPosting: false },
  { code: '3400', name: 'Owner Drawings', accountClass: 'EQUITY', reportingGroup: 'Drawings', parentCode: '3000' },
  { code: '3900', name: 'Opening Balance Equity', accountClass: 'EQUITY', reportingGroup: 'Opening Balance Equity', parentCode: '3000', isSystem: true },

  { code: '4000', name: 'Revenue', accountClass: 'REVENUE', isControlAccount: true, isSystem: true },
  { code: '4100', name: 'Sales Revenue', accountClass: 'REVENUE', reportingGroup: 'Sales Revenue', parentCode: '4000' },
  { code: '4200', name: 'Service Revenue', accountClass: 'REVENUE', reportingGroup: 'Service Revenue', parentCode: '4000' },
  { code: '4300', name: 'Other Income', accountClass: 'REVENUE', reportingGroup: 'Other Income', parentCode: '4000' },
  { code: '4900', name: 'Sales Returns and Discounts', accountClass: 'REVENUE', reportingGroup: 'Discounts', parentCode: '4000' },

  { code: '5000', name: 'Cost of Sales', accountClass: 'EXPENSE', isControlAccount: true, isSystem: true },
  { code: '5100', name: 'Food Purchases and Cost of Sales', accountClass: 'EXPENSE', reportingGroup: 'Cost of Sales', parentCode: '5000' },
  { code: '5200', name: 'Inventory Wastage', accountClass: 'EXPENSE', reportingGroup: 'Wastage', parentCode: '5000' },
  { code: '5300', name: 'Direct Labour', accountClass: 'EXPENSE', reportingGroup: 'Direct Costs', parentCode: '5000' },
  { code: '5400', name: 'Other Direct Costs', accountClass: 'EXPENSE', reportingGroup: 'Direct Costs', parentCode: '5000' },

  { code: '6000', name: 'Operating Expenses', accountClass: 'EXPENSE', isControlAccount: true, isSystem: true },
  { code: '6100', name: 'Salaries and Wages', accountClass: 'EXPENSE', reportingGroup: 'Salaries', parentCode: '6000' },
  { code: '6200', name: 'Rent', accountClass: 'EXPENSE', reportingGroup: 'Rent', parentCode: '6000' },
  { code: '6300', name: 'Utilities', accountClass: 'EXPENSE', reportingGroup: 'Utilities', parentCode: '6000' },
  { code: '6400', name: 'Marketing and Advertising', accountClass: 'EXPENSE', reportingGroup: 'Marketing', parentCode: '6000' },
  { code: '6500', name: 'Bank Charges', accountClass: 'EXPENSE', reportingGroup: 'Bank Charges', parentCode: '6000' },
  { code: '6600', name: 'Cleaning', accountClass: 'EXPENSE', reportingGroup: 'Operating Expense', parentCode: '6000' },
  { code: '6700', name: 'Repairs and Maintenance', accountClass: 'EXPENSE', reportingGroup: 'Operating Expense', parentCode: '6000' },
  { code: '6800', name: 'Depreciation Expense', accountClass: 'EXPENSE', reportingGroup: 'Depreciation', parentCode: '6000' },
  { code: '6900', name: 'Cash Over or Short', accountClass: 'EXPENSE', reportingGroup: 'Cash Over or Short', parentCode: '6000' },
  { code: '6990', name: 'Other Operating Expenses', accountClass: 'EXPENSE', reportingGroup: 'Other Expense', parentCode: '6000' },
]

const NORMAL_BALANCE = { ASSET: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT', EXPENSE: 'DEBIT' }

const MAPPINGS = {
  CASH_ON_HAND: '1110',
  DEFAULT_BANK: '1120',
  CARD_CLEARING: '1150',
  ACCOUNTS_RECEIVABLE: '1200',
  ACCOUNTS_PAYABLE: '2110',
  INVENTORY: '1300',
  SALES_REVENUE: '4100',
  OTHER_INCOME: '4300',
  COST_OF_SALES: '5100',
  DEFAULT_EXPENSE: '6990',
  INPUT_VAT: '1400',
  OUTPUT_VAT: '2200',
  WASTAGE_EXPENSE: '5200',
  CASH_OVER_SHORT: '6900',
  RETAINED_EARNINGS: '3200',
  OPENING_BALANCE_EQUITY: '3900',
}

async function createChartOfAccounts(prisma, organizationId) {
  const ids = {}
  for (const acc of ACCOUNTS) {
    const { parentCode, ...rest } = acc
    const created = await prisma.account.create({
      data: {
        ...rest,
        normalBalance: NORMAL_BALANCE[acc.accountClass],
        isControlAccount: !!acc.isControlAccount,
        allowManualPosting: acc.allowManualPosting !== undefined ? acc.allowManualPosting : !acc.isControlAccount,
        isSystem: !!acc.isSystem,
        organizationId,
      },
    })
    ids[acc.code] = created.id
  }
  for (const acc of ACCOUNTS) {
    if (acc.parentCode) await prisma.account.update({ where: { id: ids[acc.code] }, data: { parentId: ids[acc.parentCode] } })
  }
  for (const [key, code] of Object.entries(MAPPINGS)) {
    await prisma.accountingMapping.create({ data: { organizationId, key, accountId: ids[code] } })
  }
  console.log(`Created ${ACCOUNTS.length} accounts and ${Object.keys(MAPPINGS).length} account mappings`)
  return ids
}

module.exports = { ACCOUNTS, MAPPINGS, createChartOfAccounts }
