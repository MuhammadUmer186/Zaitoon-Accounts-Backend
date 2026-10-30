require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { createChartOfAccounts } = require('./reference-data')

const prisma = new PrismaClient()

// First-run setup for a brand-new (empty) production database — runs on
// every container start and does nothing once an organization exists.
// Creates only what the system needs to work, no demo data:
//   - the organization (RESTAURANT_NAME, PKR, Pakistan, Asia/Karachi)
//   - the standard chart of accounts + posting-role mappings
//   - the system roles (permissions and grants are added right after by
//     sync-permissions.js)
// The Super Admin login is created at server start from SUPER_ADMIN_EMAIL /
// SUPER_ADMIN_PASSWORD (src/utils/bootstrapSuperAdmin.ts).

const ROLES = [
  { name: 'super_admin', displayName: 'Super Admin', description: 'Full system access' },
  { name: 'admin', displayName: 'Administrator', description: 'Full access except Users & Roles, Branches and Settings' },
  { name: 'accountant', displayName: 'Accountant', description: 'Access to accounting, bills, and reports' },
  { name: 'branch_manager', displayName: 'Branch Manager', description: 'Branch-level management access' },
  { name: 'cashier', displayName: 'Cashier', description: 'Daily sales, cash closing and table orders' },
]

async function main() {
  const existing = await prisma.organization.count()
  if (existing > 0) {
    console.log('[init] Database already initialized — nothing to do')
    return
  }

  const org = await prisma.organization.create({
    data: {
      name: process.env.RESTAURANT_NAME?.trim() || 'FoodSync',
      country: 'PK',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      fiscalYearStart: '07-01',
    },
  })
  console.log(`[init] Created organization "${org.name}"`)

  await createChartOfAccounts(prisma, org.id)

  for (const role of ROLES) {
    await prisma.role.create({ data: { ...role, organizationId: org.id, isSystemRole: true } })
  }
  console.log(`[init] Created roles: ${ROLES.map((r) => r.displayName).join(', ')}`)
}

main()
  .catch((err) => {
    console.error('[init] failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
