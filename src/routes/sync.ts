import { Router, Request, Response } from 'express'
import { prisma, config } from '../config'

const router = Router()

// GET /sync/export
// Server-to-server export used by another deployment's "Fetch Data" feature.
// Guarded by a shared secret header instead of user auth, since the caller
// is another backend, not a logged-in user of this instance.
// Note: this route responds directly on error rather than throwing, because
// this codebase's async route handlers aren't wrapped to forward rejections
// to the Express error middleware.
router.get('/export', async (req: Request, res: Response) => {
  const secret = req.headers['x-sync-secret']
  if (!config.syncSecret || secret !== config.syncSecret) {
    res.status(401).json({ message: 'Invalid or missing sync secret', code: 'UNAUTHORIZED' })
    return
  }

  try {
    const [
      organizations,
      permissions,
      branches,
      users,
      roles,
      rolePermissions,
      userRoles,
      userBranchAccess,
      accounts,
      journalEntries,
      journalLines,
      dailySales,
      deliveryBreakdowns,
      cashClosings,
      expenseCategories,
      expenses,
      suppliers,
      bills,
      billItems,
      payments,
      items,
      branchStocks,
      stockMovements,
      wastageReports,
      wastageItems,
      documents,
      notifications,
      auditLogs,
    ] = await Promise.all([
      prisma.organization.findMany(),
      prisma.permission.findMany(),
      prisma.branch.findMany(),
      prisma.user.findMany(),
      prisma.role.findMany(),
      prisma.rolePermission.findMany(),
      prisma.userRole.findMany(),
      prisma.userBranchAccess.findMany(),
      prisma.account.findMany(),
      prisma.journalEntry.findMany(),
      prisma.journalLine.findMany(),
      prisma.dailySale.findMany(),
      prisma.deliveryBreakdown.findMany(),
      prisma.cashClosing.findMany(),
      prisma.expenseCategory.findMany(),
      prisma.expense.findMany(),
      prisma.supplier.findMany(),
      prisma.bill.findMany(),
      prisma.billItem.findMany(),
      prisma.payment.findMany(),
      prisma.item.findMany(),
      prisma.branchStock.findMany(),
      prisma.stockMovement.findMany(),
      prisma.wastageReport.findMany(),
      prisma.wastageItem.findMany(),
      prisma.document.findMany(),
      prisma.notification.findMany(),
      prisma.auditLog.findMany(),
    ])

    res.json({
      organizations,
      permissions,
      branches,
      users,
      roles,
      rolePermissions,
      userRoles,
      userBranchAccess,
      accounts,
      journalEntries,
      journalLines,
      dailySales,
      deliveryBreakdowns,
      cashClosings,
      expenseCategories,
      expenses,
      suppliers,
      bills,
      billItems,
      payments,
      items,
      branchStocks,
      stockMovements,
      wastageReports,
      wastageItems,
      documents,
      notifications,
      auditLogs,
    })
  } catch (err) {
    console.error('Sync export failed:', err)
    res.status(500).json({ message: 'Failed to export data', code: 'EXPORT_FAILED' })
  }
})

export default router
