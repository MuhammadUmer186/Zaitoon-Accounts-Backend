require('dotenv/config')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Read-only diagnostic: for a given org, checks every AccountingMapping
// against the exact same rule resolveMappedAccount (backend/src/utils/ledger.ts)
// uses at posting time, and prints which ones would actually block a
// transaction right now and why. Never writes anything.
// Run with: node prisma/check-mappings.js --org=<organizationId>

const args = process.argv.slice(2)
const ORG_ARG = args.find((a) => a.startsWith('--org='))
const ORG_ID = ORG_ARG ? ORG_ARG.split('=')[1] : null

if (!ORG_ID) {
  console.error('Specify --org=<organizationId>')
  process.exit(1)
}

const ALL_KEYS = [
  'CASH_ON_HAND', 'DEFAULT_BANK', 'CARD_CLEARING', 'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE', 'INVENTORY', 'SALES_REVENUE', 'OTHER_INCOME',
  'COST_OF_SALES', 'DEFAULT_EXPENSE', 'INPUT_VAT', 'OUTPUT_VAT',
  'WASTAGE_EXPENSE', 'CASH_OVER_SHORT', 'RETAINED_EARNINGS', 'OPENING_BALANCE_EQUITY',
]

async function main() {
  const org = await prisma.organization.findUnique({ where: { id: ORG_ID } })
  if (!org) {
    console.error('No organization found with that id.')
    process.exit(1)
  }
  console.log(`${org.name} (${org.id})\n`)

  const mappings = await prisma.accountingMapping.findMany({
    where: { organizationId: ORG_ID },
    include: { account: true },
  })
  const byKey = new Map(mappings.map((m) => [m.key, m]))

  for (const key of ALL_KEYS) {
    const mapping = byKey.get(key)
    if (!mapping) {
      console.log(`✗ ${key}: NOT MAPPED — would block with "MAPPING_NOT_CONFIGURED"`)
      continue
    }
    const a = mapping.account
    const problems = []
    if (a.status !== 'ACTIVE') problems.push(`status is ${a.status}, not ACTIVE`)
    if (!a.allowManualPosting) problems.push('allowManualPosting is false')
    if (a.isControlAccount) problems.push('isControlAccount is true')

    if (problems.length === 0) {
      console.log(`✓ ${key} -> ${a.code} ${a.name} — OK`)
    } else {
      console.log(`✗ ${key} -> ${a.code} ${a.name} — WOULD BLOCK: ${problems.join(', ')}`)
    }
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
