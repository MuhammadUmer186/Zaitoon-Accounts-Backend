import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { callOrderSchema, createCallOrder } from '../services/callCenter'
import { normalizePhone } from '../services/deliveryPricing'
import { orderInclude, publishOrder } from './orders'
import { posMenu } from './pos'
import { AppError } from '../middleware/error'

const router = Router()
router.use(authenticate, requirePermission('can_take_call_center_orders'))
router.use(async (req, _res, next) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account is inactive', 403, 'FORBIDDEN')
  next()
})
router.get('/menu', posMenu)
router.get('/customer', async (req, res) => {
  const query = z.object({ phone: z.string().min(7).max(30) }).parse(req.query)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const phone = normalizePhone(query.phone, org.country), branch = await branchFilter(req)
  const customer = await prisma.customer.findUnique({ where: { organizationId_phone: { organizationId: org.id, phone } } })
  const recentOrders = customer ? await prisma.customerOrder.findMany({ where: { organizationId: org.id, customerId: customer.id, ...(branch && { branchId: branch }) }, orderBy: { createdAt: 'desc' }, take: 5, include: orderInclude }) : []
  res.json({ customer, recentOrders, phone })
})
// Recovery after a reload or a lost response: did this draft's request arrive?
router.get('/requests/:requestId', async (req, res) => {
  const requestId = z.string().uuid().parse(req.params.requestId)
  const order = await prisma.customerOrder.findUnique({ where: { organizationId_intakeRequestId: { organizationId: req.user.organizationId, intakeRequestId: requestId } }, include: orderInclude })
  if (order) await assertBranchAccess(req, order.branchId)
  res.json({ order })
})
router.post('/orders', async (req, res) => {
  const result = await createCallOrder(req, callOrderSchema.parse(req.body))
  if (!result.duplicate) publishOrder(result.order, 'created')
  res.status(result.duplicate ? 200 : 201).json(result)
})
export default router
