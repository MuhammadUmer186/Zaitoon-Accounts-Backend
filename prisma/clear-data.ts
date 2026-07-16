import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Wipes all transactional/history data while preserving the org, branches,
// users, roles/permissions, and reference/setup data (chart of accounts,
// expense categories, item catalog, suppliers). Run with: npm run db:clear-data
async function main() {
  console.log('Clearing transactional data (keeping users, branches, and reference data)...')

  await prisma.auditLog.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.document.deleteMany()
  await prisma.wastageItem.deleteMany()
  await prisma.wastageReport.deleteMany()
  await prisma.stockMovement.deleteMany()
  await prisma.purchaseOrderItem.deleteMany()
  await prisma.purchaseOrder.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.billItem.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.expense.deleteMany()
  await prisma.deliveryBreakdown.deleteMany()
  await prisma.dailySale.deleteMany()
  await prisma.cashClosing.deleteMany()
  await prisma.journalLine.deleteMany()
  await prisma.journalEntry.deleteMany()
  await prisma.branchTarget.deleteMany()

  // Reset stock levels to zero rather than deleting the rows, so the
  // branch/item linkage and reorder points survive.
  await prisma.branchStock.updateMany({
    data: { quantityOnHand: 0, averageCost: 0, totalValue: 0 },
  })

  console.log('Done. Preserved: organization, branches, users, roles/permissions,')
  console.log('chart of accounts, expense categories, item catalog, suppliers.')
  console.log('Stock levels were reset to zero (rows kept).')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
