require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Factory reset: removes ALL business data so the system starts empty.
//
// Kept (the system needs these to work):
//   - the organization row (profile reset to a blank FoodSync / PKR setup)
//   - roles, permissions and their grants
//   - Super Admin / Owner logins (everyone else is removed)
//   - the chart of accounts structure, account mappings and tax rates
//   - the Breakfast / Lunch / Dinner shifts (times reset to defaults)
// Removed: branches, all other users, sales, expenses, bills, suppliers,
// inventory, purchase orders, journals, documents, menu, tables, orders,
// reviews, notifications, audit log and every uploaded file.
//
// A full JSON backup of every table, plus a copy of uploads/, is written to
// backups/ first. Run with: npm run db:reset-all-data -- --yes

const BACKUP_ROOT = path.join(__dirname, '..', 'backups')
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')
const KEEP_ROLES = ['super_admin', 'owner']

const DEFAULT_SHIFTS = [
  { name: 'Breakfast', startTime: '07:00', endTime: '11:30', sortOrder: 1 },
  { name: 'Lunch', startTime: '12:00', endTime: '16:30', sortOrder: 2 },
  { name: 'Dinner', startTime: '19:00', endTime: '23:59', sortOrder: 3 },
]

async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(BACKUP_ROOT, `before-reset-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  const models = Object.keys(prisma).filter((k) => !k.startsWith('_') && !k.startsWith('$') && typeof prisma[k]?.findMany === 'function')
  const dump = {}
  for (const m of models) dump[m] = await prisma[m].findMany()
  fs.writeFileSync(path.join(dir, 'database.json'), JSON.stringify(dump, null, 1))
  if (fs.existsSync(UPLOAD_ROOT)) fs.cpSync(UPLOAD_ROOT, path.join(dir, 'uploads'), { recursive: true })
  const rows = Object.values(dump).reduce((n, list) => n + list.length, 0)
  console.log(`Backup: ${rows} rows from ${models.length} tables -> ${dir}`)
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.log('This permanently deletes ALL business data (a backup is written first).')
    console.log('Re-run with --yes to continue:  npm run db:reset-all-data -- --yes')
    process.exit(1)
  }

  await backup()

  const keepUsers = await prisma.user.findMany({
    where: { roles: { some: { role: { name: { in: KEEP_ROLES } } } } },
    select: { id: true, email: true },
  })
  if (keepUsers.length === 0) throw new Error('No Super Admin user found — refusing to continue (nobody could log in afterwards)')
  const keepIds = keepUsers.map((u) => u.id)

  const steps = [
    // HR children before employees and branches; the backup includes all HR tables.
    ['hrPayrollPayment'], ['hrPayrollLine'], ['hrPayrollRun'], ['hrLeaveRequest'],
    ['hrAttendance'], ['hrRecord'], ['hrEmployee'], ['hrSettings'],
    // QR ordering & menu
    ['orderReview'], ['customerOrderItem'], ['customerOrder'], ['dishOutOfStock'], ['dishShift'], ['dish'], ['menuCategory'], ['diningTable'],
    // activity
    ['auditLog'], ['notification'], ['document'], ['refreshToken'],
    // inventory & purchasing
    ['wastageItem'], ['wastageReport'], ['stockMovement'], ['stockOut'], ['branchSection'], ['branchStock'],
    ['purchaseOrderItem'], ['purchaseOrder'], ['item'], ['itemCategory'],
    // payables & expenses & sales
    ['payment'], ['billItem'], ['bill'], ['supplier'], ['expense'], ['expenseCategory'],
    ['deliveryBreakdown'], ['dailySale'], ['cashClosing'],
    // ledger
    ['journalLine'], ['journalEntry'], ['accountingPeriod'], ['branchTarget'], ['bankAccount'],
    // people & branches
    ['userBranchAccess'],
    ['user', { id: { notIn: keepIds } }],
  ]
  for (const [model, where] of steps) {
    const { count } = await prisma[model].deleteMany(where ? { where } : undefined)
    if (count) console.log(`  ${model}: ${count} deleted`)
  }

  await prisma.account.updateMany({ where: { branchId: { not: null } }, data: { branchId: null } })
  const branches = await prisma.branch.deleteMany()
  console.log(`  branch: ${branches.count} deleted`)

  await prisma.organization.updateMany({
    data: {
      name: 'FoodSync',
      tradeName: null,
      registrationNo: null,
      vatNumber: null,
      email: null,
      phone: null,
      address: null,
      city: null,
      country: 'PK',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      logoUrl: null,
      logoPath: null,
      lowStockThreshold: null,
    },
  })

  const orgs = await prisma.organization.findMany({ select: { id: true } })
  for (const org of orgs) {
    for (const s of DEFAULT_SHIFTS) {
      await prisma.menuShift.upsert({
        where: { organizationId_name: { organizationId: org.id, name: s.name } },
        update: { startTime: s.startTime, endTime: s.endTime, sortOrder: s.sortOrder, isActive: true },
        create: { ...s, organizationId: org.id },
      })
    }
  }

  // Uploaded files (documents, dish photos, review photos, logo) — already copied into the backup
  if (fs.existsSync(UPLOAD_ROOT)) {
    for (const entry of fs.readdirSync(UPLOAD_ROOT)) fs.rmSync(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true })
  }

  console.log('')
  console.log('Done. The system is empty and set to PKR / Asia/Karachi.')
  console.log(`Logins kept: ${keepUsers.map((u) => u.email).join(', ')} (everyone must sign in again).`)
  console.log('Next: Settings (restaurant name, logo) -> Branches -> Users -> Menu -> Tables & QR.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
