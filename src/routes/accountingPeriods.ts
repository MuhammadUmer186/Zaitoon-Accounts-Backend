import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { financeTransaction, financeLock } from '../utils/financeTransaction'

const router = Router()
router.use(authenticate)

const periodSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

router.get('/', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const periods = await prisma.accountingPeriod.findMany({
    where: { organizationId: req.user.organizationId },
    orderBy: { startDate: 'desc' },
  })
  res.json({ data: periods })
})

router.post('/', requirePermission('accounting_periods_manage'), async (req: Request, res: Response) => {
  const body = periodSchema.parse(req.body)
  const orgId = req.user.organizationId
  const startDate = new Date(body.startDate)
  const endDate = new Date(body.endDate)
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) throw new AppError('Invalid accounting period dates', 400, 'VALIDATION_ERROR')
  if (startDate.toISOString().slice(0, 10) !== body.startDate || endDate.toISOString().slice(0, 10) !== body.endDate) throw new AppError('Invalid accounting period dates', 400, 'VALIDATION_ERROR')
  if (/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) endDate.setUTCHours(23, 59, 59, 999)
  if (endDate < startDate) throw new AppError('End date must be on or after the start date', 400, 'VALIDATION_ERROR')

  const period = await financeTransaction(prisma, async (tx) => {
    await financeLock(tx, `period:${orgId}`)
    const overlap = await tx.accountingPeriod.findFirst({ where: { organizationId: orgId, startDate: { lte: endDate }, endDate: { gte: startDate } } })
    if (overlap) throw new AppError('Accounting period overlaps an existing period', 400, 'PERIOD_OVERLAP')
    return tx.accountingPeriod.create({ data: { organizationId: orgId, name: body.name, startDate, endDate } })
  })
  await logAudit(prisma, { req, action: 'accounting_period.created', module: 'accounts', resourceType: 'accounting_period', resourceId: period.id, resourceRef: period.name, newData: period })
  res.status(201).json(period)
})

async function transition(req: Request, res: Response, opts: {
  from: string[]; to: string; action: string
  data: (userId: string) => Record<string, unknown>
}) {
  const orgId = req.user.organizationId
  const updated = await financeTransaction(prisma, async (tx) => {
  await financeLock(tx, `period:${orgId}`)
  const period = await tx.accountingPeriod.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!period) throw new AppError('Accounting period not found', 404, 'NOT_FOUND')
  if (!opts.from.includes(period.status)) {
    throw new AppError(`Only a ${opts.from.join('/').toLowerCase()} period can be ${opts.to.toLowerCase()}ed`, 400, 'INVALID_STATUS')
  }

  const updated = await tx.accountingPeriod.update({
    where: { id: period.id },
    data: { status: opts.to as never, ...opts.data(req.user.id) },
  })
  await logAudit(tx, { req, action: opts.action, module: 'accounts', resourceType: 'accounting_period', resourceId: period.id, resourceRef: period.name, oldData: { status: period.status }, newData: { status: updated.status } })
  return updated
  })
  res.json(updated)
}

router.post('/:id/lock', requirePermission('accounting_periods_manage'), (req, res) =>
  transition(req, res, { from: ['OPEN'], to: 'LOCKED', action: 'accounting_period.locked', data: (userId) => ({ lockedAt: new Date(), lockedById: userId }) }))

router.post('/:id/unlock', requirePermission('accounting_periods_manage'), (req, res) =>
  transition(req, res, { from: ['LOCKED'], to: 'OPEN', action: 'accounting_period.unlocked', data: () => ({ lockedAt: null, lockedById: null }) }))

router.post('/:id/close', requirePermission('accounting_periods_manage'), (req, res) =>
  transition(req, res, { from: ['LOCKED'], to: 'CLOSED', action: 'accounting_period.closed', data: (userId) => ({ closedAt: new Date(), closedById: userId }) }))

// Reopening a closed period is deliberately its own explicit, audited action
// rather than a side effect of "unlock" — closing is meant to be a firmer
// commitment than a lock.
router.post('/:id/reopen', requirePermission('accounting_periods_manage'), (req, res) =>
  transition(req, res, { from: ['CLOSED'], to: 'LOCKED', action: 'accounting_period.reopened', data: () => ({ closedAt: null, closedById: null }) }))

export default router
