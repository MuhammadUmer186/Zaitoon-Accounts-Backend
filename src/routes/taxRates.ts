import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'

const router = Router()
router.use(authenticate)

const taxRateSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  rate: z.number().min(0).max(100),
  type: z.enum(['INPUT', 'OUTPUT', 'BOTH', 'EXEMPT']),
  isDefault: z.boolean().default(false),
})

router.get('/', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const rates = await prisma.taxRate.findMany({
    where: { organizationId: req.user.organizationId },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  })
  res.json({ data: rates })
})

router.post('/', requirePermission('tax_rates_manage'), async (req: Request, res: Response) => {
  const body = taxRateSchema.parse(req.body)
  const orgId = req.user.organizationId

  const existing = await prisma.taxRate.findFirst({ where: { organizationId: orgId, code: body.code } })
  if (existing) throw new AppError(`Tax rate code "${body.code}" is already in use`, 400, 'DUPLICATE_CODE')

  if (body.isDefault) {
    await prisma.taxRate.updateMany({ where: { organizationId: orgId, isDefault: true }, data: { isDefault: false } })
  }

  const rate = await prisma.taxRate.create({ data: { ...body, organizationId: orgId } })
  await logAudit(prisma, { req, action: 'tax_rate.created', module: 'accounts', resourceType: 'tax_rate', resourceId: rate.id, resourceRef: rate.code, newData: rate })
  res.status(201).json(rate)
})

router.patch('/:id', requirePermission('tax_rates_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const existing = await prisma.taxRate.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!existing) throw new AppError('Tax rate not found', 404, 'NOT_FOUND')

  const body = taxRateSchema.partial().parse(req.body)

  // Changing a rate's percentage or default status never touches historical
  // journal lines or VAT reports — those already recorded their own amounts
  // at posting time. This only affects future transactions.
  if (body.isDefault) {
    await prisma.taxRate.updateMany({ where: { organizationId: orgId, isDefault: true }, data: { isDefault: false } })
  }

  const updated = await prisma.taxRate.update({ where: { id: existing.id }, data: body })
  await logAudit(prisma, { req, action: 'tax_rate.edited', module: 'accounts', resourceType: 'tax_rate', resourceId: updated.id, oldData: existing, newData: updated })
  res.json(updated)
})

router.post('/:id/archive', requirePermission('tax_rates_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const existing = await prisma.taxRate.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!existing) throw new AppError('Tax rate not found', 404, 'NOT_FOUND')

  const updated = await prisma.taxRate.update({ where: { id: existing.id }, data: { isActive: false, isDefault: false } })
  await logAudit(prisma, { req, action: 'tax_rate.archived', module: 'accounts', resourceType: 'tax_rate', resourceId: updated.id })
  res.json(updated)
})

export default router
