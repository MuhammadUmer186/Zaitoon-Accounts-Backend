require('dotenv/config')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Safe, manual upgrade for organizations whose Chart of Accounts predates the
// Accounts module (reportingGroup/isControlAccount/allowManualPosting/
// AccountingMapping did not exist yet). Never deletes, merges, or renumbers
// an existing account — existing ids and all JournalLine relations are
// preserved untouched. Only:
//   - backfills reportingGroup / isControlAccount / allowManualPosting on
//     existing rows, best-effort, from a legacy-code lookup table covering
//     both numbering variants this codebase has used historically
//   - creates the standard-chart accounts (and their control-account
//     parents) that are genuinely missing
//   - creates AccountingMapping rows so operational posting (sales,
//     expenses, bills, wastage, cash closing) keeps working now that
//     silent on-the-fly account creation has been removed
//   - reports duplicate codes, invalid classes, and unbalanced posted
//     journals for manual review
//
// Defaults to DRY RUN — prints what it would do and writes nothing. Pass
// --commit to actually write. Pass --org=<organizationId> to target one org,
// or --all to process every organization.
//
// Run with:
//   node prisma/upgrade-chart-of-accounts.js --org=<id>            (dry run)
//   node prisma/upgrade-chart-of-accounts.js --org=<id> --commit   (writes)
//   node prisma/upgrade-chart-of-accounts.js --all --commit
//
// This script is never invoked automatically during deploy or app startup.

const args = process.argv.slice(2)
const COMMIT = args.includes('--commit')
const ALL = args.includes('--all')
const ORG_ARG = args.find((a) => a.startsWith('--org='))
const ORG_ID = ORG_ARG ? ORG_ARG.split('=')[1] : null

if (!ALL && !ORG_ID) {
  console.error('Specify --org=<organizationId> or --all. See the file header for usage.')
  process.exit(1)
}

// Best-effort classification for accounts created before reportingGroup /
// AccountingMapping existed — covers both numbering variants seen in this
// codebase's history (ledger.ts's runtime fallback defaults, and seed.js's
// original demo chart). Anything not listed here is left with a null
// reportingGroup rather than guessed — an admin can set it later in the UI.
const LEGACY_CODE_INFO = {
  '1000': { reportingGroup: 'Cash', mappingKey: 'CASH_ON_HAND' },
  '1010': { reportingGroup: 'Bank', mappingKey: 'DEFAULT_BANK' },
  '1020': { reportingGroup: 'Cash' },
  '1100': { reportingGroup: 'Accounts Receivable', mappingKey: 'ACCOUNTS_RECEIVABLE' },
  '1110': { reportingGroup: 'Input VAT', mappingKey: 'INPUT_VAT' },
  '1200': { reportingGroup: 'Inventory', mappingKey: 'INVENTORY' },
  '1300': { reportingGroup: 'Prepayments' },
  '1400': { reportingGroup: 'Bank', mappingKey: 'CARD_CLEARING' },
  '1410': { reportingGroup: 'Accounts Receivable' },
  '2000': { reportingGroup: 'Accounts Payable', mappingKey: 'ACCOUNTS_PAYABLE' },
  '2100': { reportingGroup: 'Output VAT', mappingKey: 'OUTPUT_VAT' },
  '2200': { reportingGroup: 'Accrued Expenses' },
  '2300': { reportingGroup: 'Other Liabilities' },
  '3000': { reportingGroup: 'Owner Capital' },
  '3100': { reportingGroup: 'Retained Earnings', mappingKey: 'RETAINED_EARNINGS' },
  '4000': { reportingGroup: 'Sales Revenue', mappingKey: 'SALES_REVENUE' },
  '4010': { reportingGroup: 'Other Income' },
  '4020': { reportingGroup: 'Other Income', mappingKey: 'OTHER_INCOME' },
  '5000': { reportingGroup: 'Cost of Sales', isControl: true },
  '5100': { reportingGroup: 'Cost of Sales', mappingKey: 'COST_OF_SALES' },
  '5200': { reportingGroup: 'Direct Costs' },
  '5300': { reportingGroup: 'Direct Costs' },
  '5400': { reportingGroup: 'Wastage', mappingKey: 'WASTAGE_EXPENSE' },
  '6000': { reportingGroup: 'Operating Expense', isControl: true },
  '6100': { reportingGroup: 'Salaries' },
  '6200': { reportingGroup: 'Rent' },
  '6300': { reportingGroup: 'Utilities' },
  '6400': { reportingGroup: 'Marketing' },
  '6500': { reportingGroup: 'Operating Expense' },
  '6600': { reportingGroup: 'Marketing' },
  '6700': { reportingGroup: 'Other Expense', mappingKey: 'DEFAULT_EXPENSE' },
  '6800': { reportingGroup: 'Bank Charges' },
  '6900': { reportingGroup: 'Cash Over or Short', mappingKey: 'CASH_OVER_SHORT' },
}

// Standard accounts to create ONLY when an organization has no existing
// account resolvable for that mapping key — additive, never replacing.
const STANDARD_FALLBACK = {
  CASH_ON_HAND: { code: '1110', name: 'Cash on Hand', accountClass: 'ASSET', reportingGroup: 'Cash', parentCode: '1100', parentName: 'Current Assets' },
  DEFAULT_BANK: { code: '1120', name: 'Bank Accounts', accountClass: 'ASSET', reportingGroup: 'Bank', parentCode: '1100', parentName: 'Current Assets' },
  CARD_CLEARING: { code: '1150', name: 'Card Clearing', accountClass: 'ASSET', reportingGroup: 'Bank', parentCode: '1100', parentName: 'Current Assets' },
  ACCOUNTS_RECEIVABLE: { code: '1200', name: 'Accounts Receivable', accountClass: 'ASSET', reportingGroup: 'Accounts Receivable', parentCode: '1100', parentName: 'Current Assets' },
  ACCOUNTS_PAYABLE: { code: '2110', name: 'Accounts Payable', accountClass: 'LIABILITY', reportingGroup: 'Accounts Payable', parentCode: '2100', parentName: 'Current Liabilities' },
  INVENTORY: { code: '1300', name: 'Inventory', accountClass: 'ASSET', reportingGroup: 'Inventory', parentCode: '1100', parentName: 'Current Assets' },
  SALES_REVENUE: { code: '4100', name: 'Sales Revenue', accountClass: 'REVENUE', reportingGroup: 'Sales Revenue', parentCode: '4000', parentName: 'Revenue' },
  OTHER_INCOME: { code: '4300', name: 'Other Income', accountClass: 'REVENUE', reportingGroup: 'Other Income', parentCode: '4000', parentName: 'Revenue' },
  COST_OF_SALES: { code: '5100', name: 'Food Purchases and Cost of Sales', accountClass: 'EXPENSE', reportingGroup: 'Cost of Sales', parentCode: '5000', parentName: 'Cost of Sales' },
  DEFAULT_EXPENSE: { code: '6990', name: 'Other Operating Expenses', accountClass: 'EXPENSE', reportingGroup: 'Other Expense', parentCode: '6000', parentName: 'Operating Expenses' },
  INPUT_VAT: { code: '1400', name: 'Input VAT', accountClass: 'ASSET', reportingGroup: 'Input VAT', parentCode: '1100', parentName: 'Current Assets' },
  OUTPUT_VAT: { code: '2200', name: 'Output VAT', accountClass: 'LIABILITY', reportingGroup: 'Output VAT', parentCode: '2100', parentName: 'Current Liabilities' },
  WASTAGE_EXPENSE: { code: '5200', name: 'Inventory Wastage', accountClass: 'EXPENSE', reportingGroup: 'Wastage', parentCode: '5000', parentName: 'Cost of Sales' },
  CASH_OVER_SHORT: { code: '6900', name: 'Cash Over or Short', accountClass: 'EXPENSE', reportingGroup: 'Cash Over or Short', parentCode: '6000', parentName: 'Operating Expenses' },
  RETAINED_EARNINGS: { code: '3200', name: 'Retained Earnings', accountClass: 'EQUITY', reportingGroup: 'Retained Earnings', parentCode: '3000', parentName: 'Equity' },
  OPENING_BALANCE_EQUITY: { code: '3900', name: 'Opening Balance Equity', accountClass: 'EQUITY', reportingGroup: 'Opening Balance Equity', parentCode: '3000', parentName: 'Equity', isSystem: true },
}

const CONTROL_PARENTS = {
  '1000': { name: 'Assets', accountClass: 'ASSET' },
  '1100': { name: 'Current Assets', accountClass: 'ASSET', parentCode: '1000' },
  '2000': { name: 'Liabilities', accountClass: 'LIABILITY' },
  '2100': { name: 'Current Liabilities', accountClass: 'LIABILITY', parentCode: '2000' },
  '3000': { name: 'Equity', accountClass: 'EQUITY' },
  '4000': { name: 'Revenue', accountClass: 'REVENUE' },
  '5000': { name: 'Cost of Sales', accountClass: 'EXPENSE' },
  '6000': { name: 'Operating Expenses', accountClass: 'EXPENSE' },
}

async function upgradeOrg(org, report) {
  console.log(`\n── ${org.name} (${org.id}) ──`)
  const accounts = await prisma.account.findMany({ where: { organizationId: org.id } })
  const byCode = new Map(accounts.map((a) => [a.code, a]))

  // 1) Backfill classification on existing accounts missing a reportingGroup.
  let backfilled = 0
  for (const acc of accounts) {
    if (acc.reportingGroup) continue
    const info = LEGACY_CODE_INFO[acc.code]
    if (!info) continue
    backfilled++
    console.log(`  backfill ${acc.code} ${acc.name}: reportingGroup="${info.reportingGroup}"${info.isControl ? ', isControlAccount=true' : ''}`)
    if (COMMIT) {
      await prisma.account.update({
        where: { id: acc.id },
        data: {
          reportingGroup: info.reportingGroup,
          ...(info.isControl ? { isControlAccount: true, allowManualPosting: false } : {}),
        },
      })
    }
  }
  report.backfilled += backfilled

  // 2) Create missing control-account parents (additive only).
  const controlIdByCode = {}
  for (const [code, def] of Object.entries(CONTROL_PARENTS)) {
    let acc = byCode.get(code)
    if (!acc) {
      console.log(`  create control account ${code} ${def.name}`)
      if (COMMIT) {
        acc = await prisma.account.create({
          data: {
            organizationId: org.id, code, name: def.name, accountClass: def.accountClass,
            normalBalance: { ASSET: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT', EXPENSE: 'DEBIT' }[def.accountClass],
            isControlAccount: true, allowManualPosting: false, isSystem: true, createdById: null,
          },
        })
        byCode.set(code, acc)
      }
      report.accountsCreated++
    }
    controlIdByCode[code] = acc?.id
  }
  if (COMMIT) {
    for (const [code, def] of Object.entries(CONTROL_PARENTS)) {
      if (def.parentCode && byCode.get(code) && !byCode.get(code).parentId) {
        await prisma.account.update({ where: { id: byCode.get(code).id }, data: { parentId: controlIdByCode[def.parentCode] } })
      }
    }
  }

  // 3) Resolve (or create) an account for every required mapping key.
  const existingMappings = await prisma.accountingMapping.findMany({ where: { organizationId: org.id } })
  const mappedKeys = new Set(existingMappings.map((m) => m.key))

  for (const [key, fallback] of Object.entries(STANDARD_FALLBACK)) {
    if (mappedKeys.has(key)) continue

    // Prefer an existing account whose legacy code maps to this same key.
    let target = [...byCode.values()].find((a) => LEGACY_CODE_INFO[a.code]?.mappingKey === key)

    if (!target) {
      target = byCode.get(fallback.code)
      if (!target) {
        console.log(`  create standard account ${fallback.code} ${fallback.name} (for mapping ${key})`)
        if (COMMIT) {
          target = await prisma.account.create({
            data: {
              organizationId: org.id, code: fallback.code, name: fallback.name, accountClass: fallback.accountClass,
              reportingGroup: fallback.reportingGroup,
              normalBalance: { ASSET: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT', EXPENSE: 'DEBIT' }[fallback.accountClass],
              parentId: controlIdByCode[fallback.parentCode],
              isSystem: !!fallback.isSystem,
            },
          })
          byCode.set(fallback.code, target)
        }
        report.accountsCreated++
      }
    }

    console.log(`  map ${key} -> ${fallback.code} ${fallback.name}${target ? '' : ' (dry run — id not yet assigned)'} — please verify in Accounts > Settings`)
    if (COMMIT && target) {
      await prisma.accountingMapping.create({ data: { organizationId: org.id, key, accountId: target.id } })
    }
    report.mappingsCreated++
  }

  // 7) Detect duplicate codes (defense-in-depth; the DB constraint should
  // already prevent this going forward).
  const codeCounts = {}
  for (const a of accounts) codeCounts[a.code] = (codeCounts[a.code] || 0) + 1
  for (const [code, count] of Object.entries(codeCounts)) {
    if (count > 1) { console.warn(`  ⚠ duplicate code ${code} appears ${count} times`); report.warnings.push(`${org.name}: duplicate code ${code}`) }
  }

  // 8) Detect invalid account classes (defensive — should be impossible once
  // accountClass is a real Postgres enum column).
  const validClasses = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])
  for (const a of accounts) {
    if (!validClasses.has(a.accountClass)) { console.warn(`  ⚠ account ${a.code} has invalid accountClass "${a.accountClass}"`); report.warnings.push(`${org.name}: invalid class on ${a.code}`) }
  }

  // 9) Detect unbalanced posted journals.
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: org.id, status: 'posted' }, select: { entryNo: true, totalDebit: true, totalCredit: true } })
  for (const e of entries) {
    if (Math.abs(Number(e.totalDebit) - Number(e.totalCredit)) > 0.01) {
      console.warn(`  ⚠ journal entry ${e.entryNo} is unbalanced (debit ${e.totalDebit} ≠ credit ${e.totalCredit})`)
      report.warnings.push(`${org.name}: unbalanced journal ${e.entryNo}`)
    }
  }
}

async function main() {
  console.log(`Chart of Accounts upgrade — ${COMMIT ? 'COMMIT (writing changes)' : 'DRY RUN (no changes will be written)'}`)

  const orgs = ALL
    ? await prisma.organization.findMany()
    : await prisma.organization.findMany({ where: { id: ORG_ID } })

  if (orgs.length === 0) {
    console.error('No matching organization(s) found.')
    process.exit(1)
  }

  const report = { backfilled: 0, accountsCreated: 0, mappingsCreated: 0, warnings: [] }
  for (const org of orgs) await upgradeOrg(org, report)

  console.log('\n── Reconciliation report ──')
  console.log(`Accounts backfilled with reportingGroup: ${report.backfilled}`)
  console.log(`Accounts created: ${report.accountsCreated}`)
  console.log(`Mappings created: ${report.mappingsCreated}`)
  console.log(`Warnings: ${report.warnings.length}`)
  for (const w of report.warnings) console.log(`  - ${w}`)

  if (!COMMIT) console.log('\nThis was a dry run — re-run with --commit to write these changes.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
