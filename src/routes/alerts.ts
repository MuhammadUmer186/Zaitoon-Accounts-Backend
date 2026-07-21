import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { getEverStockedKeys, isNeverStocked } from '../utils/stock'

const router = Router()

router.use(authenticate)

type AlertLevel = 'critical' | 'warning' | 'good' | 'info'

interface Alert {
  id: string
  level: AlertLevel
  module: string
  branchId?: string
  branchName?: string
  message: string
  createdAt: string
  link?: string
}

// GET /alerts — real, computed-on-the-fly alerts (nothing fabricated/stored)
router.get('/', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const now = new Date()
  const branchFilter = branchId ? { branchId } : {}

  const alerts: Alert[] = []

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { lowStockThreshold: true },
  })
  const globalThreshold = org?.lowStockThreshold ?? null

  // ── Overdue supplier bills ────────────────────────────────────────────────
  const overdueBills = await prisma.bill.findMany({
    where: {
      organizationId: orgId,
      ...branchFilter,
      status: { notIn: ['paid', 'void'] },
      dueDate: { lt: now },
    },
    include: { supplier: { select: { name: true } }, branch: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
    take: 20,
  })
  for (const bill of overdueBills) {
    const daysOverdue = Math.floor((now.getTime() - bill.dueDate.getTime()) / (1000 * 60 * 60 * 24))
    alerts.push({
      id: `bill-${bill.id}`,
      level: 'critical',
      module: 'bills',
      branchId: bill.branch.id,
      branchName: bill.branch.name,
      message: `${bill.supplier.name} bill ${bill.billNo} overdue by ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} — SAR ${bill.balanceDue.toFixed(2)}`,
      createdAt: bill.dueDate.toISOString(),
      link: '/suppliers',
    })
  }

  // ── Low / critical stock ──────────────────────────────────────────────────
  const [stocks, everStocked] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...branchFilter },
      include: { item: { select: { name: true, unit: true } }, branch: { select: { id: true, name: true } } },
    }),
    getEverStockedKeys(prisma, orgId),
  ])
  for (const st of stocks) {
    // A catalog item that has sat at zero since creation was never actually
    // received via a purchase — that's not a "critically low" situation,
    // it just hasn't been stocked yet, so it shouldn't alert.
    if (isNeverStocked(everStocked, st.branchId, st.itemId, st.quantityOnHand)) continue
    // When an org-wide threshold is set, it applies uniformly to every
    // product (overrides each item's individual reorder point). Otherwise
    // fall back to the item/branch-specific reorder point.
    const threshold = globalThreshold ?? st.reorderPoint
    if (st.quantityOnHand >= threshold) continue
    const critical = st.quantityOnHand <= threshold * 0.5
    alerts.push({
      id: `stock-${st.id}`,
      level: critical ? 'critical' : 'warning',
      module: 'inventory',
      branchId: st.branch.id,
      branchName: st.branch.name,
      message: `${st.item.name} at ${st.branch.name} is ${critical ? 'critically low' : 'below threshold'} — ${st.quantityOnHand} ${st.item.unit} remaining (alert threshold ${threshold})`,
      createdAt: st.lastUpdated.toISOString(),
      link: '/inventory',
    })
  }

  // ── Cash closing discrepancies (last 30 days) ─────────────────────────────
  const last30Days = new Date(now)
  last30Days.setDate(now.getDate() - 30)
  const discrepancies = await prisma.cashClosing.findMany({
    where: {
      organizationId: orgId,
      ...branchFilter,
      closingDate: { gte: last30Days },
      differenceType: { not: 'balanced' },
    },
    include: { branch: { select: { id: true, name: true } } },
    orderBy: { closingDate: 'desc' },
    take: 20,
  })
  for (const c of discrepancies) {
    if (Math.abs(c.difference) < 50) continue
    alerts.push({
      id: `cash-${c.id}`,
      level: 'warning',
      module: 'cash_closing',
      branchId: c.branch.id,
      branchName: c.branch.name,
      message: `Cash closing ${c.closingNo} at ${c.branch.name} is ${c.differenceType === 'short' ? 'short' : 'in excess'} by SAR ${Math.abs(c.difference).toFixed(2)}`,
      createdAt: c.closingDate.toISOString(),
      link: '/cash-closing',
    })
  }

  // ── Purchase orders pending approval ──────────────────────────────────────
  const pendingPOs = await prisma.purchaseOrder.findMany({
    where: { organizationId: orgId, ...branchFilter, status: 'submitted' },
    include: { branch: { select: { id: true, name: true } }, items: { select: { id: true } } },
    orderBy: { submittedAt: 'asc' },
    take: 20,
  })
  for (const po of pendingPOs) {
    const ageDays = po.submittedAt ? Math.floor((now.getTime() - po.submittedAt.getTime()) / (1000 * 60 * 60 * 24)) : 0
    alerts.push({
      id: `po-${po.id}`,
      level: ageDays >= 2 ? 'warning' : 'info',
      module: 'purchase_orders',
      branchId: po.branch.id,
      branchName: po.branch.name,
      message: `Purchase order ${po.poNo} (${po.items.length} item${po.items.length === 1 ? '' : 's'}) at ${po.branch.name} awaiting approval${ageDays > 0 ? ` (${ageDays}d)` : ''}`,
      createdAt: (po.submittedAt ?? po.createdAt).toISOString(),
      link: '/purchase-orders',
    })
  }

  // ── Sort: critical first, then warning, then info; most recent first ─────
  const levelOrder: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2, good: 3 }
  alerts.sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || (b.createdAt.localeCompare(a.createdAt)))

  if (alerts.length === 0) {
    alerts.push({
      id: 'ok',
      level: 'good',
      module: 'system',
      message: 'All systems nominal — no active alerts',
      createdAt: now.toISOString(),
    })
  }

  res.json({ data: alerts })
})

export default router
