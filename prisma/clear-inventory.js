require('dotenv/config')
const fs = require('fs')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Wipes everything inventory-related: all purchase orders, all stock
// movement history, resets every branch's stock to zero, and removes the
// Supplier Bills (+ payments + invoice files) that were auto-created by the
// Add Purchase flow specifically (identified via the 'purchase' stock
// movement reference — manually-entered supplier bills unrelated to
// inventory receiving are left untouched). Users, branches, the item
// catalog, and suppliers are all preserved. Run with: npm run db:clear-inventory
async function main() {
  console.log('Clearing inventory data...')

  const purchaseMovements = await prisma.stockMovement.findMany({
    where: { referenceType: 'purchase' },
    select: { referenceId: true },
  })
  const billIds = [...new Set(purchaseMovements.map((m) => m.referenceId).filter(Boolean))]

  if (billIds.length > 0) {
    const bills = await prisma.bill.findMany({
      where: { id: { in: billIds } },
      select: { id: true, documentId: true },
    })
    const docIds = bills.map((b) => b.documentId).filter(Boolean)

    await prisma.payment.deleteMany({ where: { billId: { in: billIds } } })
    await prisma.billItem.deleteMany({ where: { billId: { in: billIds } } })
    await prisma.bill.deleteMany({ where: { id: { in: billIds } } })
    console.log(`Removed ${bills.length} bill(s) created via purchase receiving.`)

    if (docIds.length > 0) {
      const docs = await prisma.document.findMany({ where: { id: { in: docIds } } })
      for (const doc of docs) {
        try { fs.unlinkSync(doc.filePath) } catch { /* best-effort cleanup */ }
      }
      await prisma.document.deleteMany({ where: { id: { in: docIds } } })
      console.log(`Removed ${docs.length} attached invoice file(s).`)
    }
  }

  await prisma.stockMovement.deleteMany()
  await prisma.purchaseOrderItem.deleteMany()
  const { count: poCount } = await prisma.purchaseOrder.deleteMany()
  console.log(`Removed ${poCount} purchase order(s) and all stock movement history.`)

  const { count: stockCount } = await prisma.branchStock.updateMany({
    data: { quantityOnHand: 0, averageCost: 0, totalValue: 0 },
  })
  console.log(`Reset ${stockCount} branch stock row(s) to zero (rows kept).`)

  console.log('Done. Preserved: organization, branches, users, suppliers, and the item catalog.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
