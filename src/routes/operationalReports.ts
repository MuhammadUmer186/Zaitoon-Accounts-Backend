import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireExportPermission, requireModule } from '../middleware/authorize'
import { withReportingScope } from '../middleware/reportScope'
import { withReportFormat } from '../utils/reportFormat'
import { periodLabelFor, reportScope, sendProReport } from '../utils/proReport'
import { OperationalReportKey, operationalReportNames, operationalSections } from '../services/operationalReports'
import { AppError } from '../middleware/error'
import { reportReadScope } from '../utils/reportReadScope'

const router = Router()
router.get('/source-order/:id', authenticate, requireModule('reports'), withReportingScope, withReportFormat, async (req, res) => {
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, include: { branch: { select: { name: true } }, items: true, checks: true } })
  if (!order) throw new AppError('Order not found in your reporting scope', 404, 'NOT_FOUND')
  const payments = await prisma.tillPayment.findMany({ where: { organizationId: req.user.organizationId, orderId: order.id }, orderBy: { createdAt: 'asc' } })
  res.json({ order: { orderNo: order.orderNo, branch: order.branch.name, status: order.status, totalAmount: order.totalAmount, vatAmount: order.vatAmount, discountAmount: order.discountAmount + order.promotionAmount, foodCost: order.foodCost }, items: order.items.map(i => ({ dish: i.dishName, quantity: i.quantity, total: i.lineTotal, cost: i.unitCost * i.quantity, status: i.status })), payments: payments.map(p => ({ date: p.createdAt.toISOString(), method: p.method, type: p.type, amount: p.amount })), checks: order.checks.map(c => ({ label: c.label, amount: c.totalAmount, status: c.status })) })
})
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Invalid calendar date')
const filters = z.object({ branchId: z.string().min(1).optional(), fromDate: date.optional(), toDate: date.optional(), format: z.enum(['pdf', 'excel', 'csv']).optional() }).refine(v => !v.fromDate || !v.toDate || v.fromDate <= v.toDate, 'Start date must be on or before end date')
// Match only these paths so this router does not affect existing catalog reports.
for (const key of Object.keys(operationalReportNames) as OperationalReportKey[]) {
  router.get(`/${key}`, authenticate, requireModule('reports'), requireExportPermission, withReportingScope, withReportFormat, async (req, res) => {
    const query = filters.parse(req.query)
    if (query.branchId && !await prisma.branch.count({ where: { id: query.branchId, organizationId: req.user.organizationId } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
    const data = await prisma.$transaction(async tx => {
      // A consistent snapshot for current/prior periods, with inherited branch scope.
      return operationalSections(key, { ...query, organizationId: req.user.organizationId }, tx)
    }, { timeout: 120000, isolationLevel: 'RepeatableRead' })
    const entity = await reportScope(prisma, req.user.organizationId, query.branchId)
    const authorized = reportReadScope.getStore()?.branchIds
    if (!query.branchId && authorized) {
      const branches = await prisma.branch.findMany({ where: { organizationId: req.user.organizationId, id: { in: authorized } }, select: { name: true } })
      entity.scopeLabel = branches.length ? branches.map(b => b.name).join(', ') : 'No authorized branches'
    }
    const report = {
      key, eyebrow: operationalReportNames[key], headline: operationalReportNames[key],
      ...entity,
      periodLabel: periodLabelFor(query.fromDate, query.toDate), generatedAt: new Date().toISOString(),
      summaryLine: '', ...data,
    }
    await sendProReport(res, query.format, report)
  })
}
export default router
