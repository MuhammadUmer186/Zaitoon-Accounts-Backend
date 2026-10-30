import { validMoneyPrecision } from '../utils/money'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { formatContextFor, momentRange, todayInZone, formatDateTime } from '../utils/reportFormat'
import { ProReport, sendProReport } from '../utils/proReport'
import { normalizeArea, normalizePhone, validateDeliveryTax } from '../services/deliveryPricing'
import { transitionDelivery } from '../services/delivery'
import { settleRiderCash } from '../services/deliveryCash'
import { orderInclude, publishOrder } from './orders'
import { issueForOrder } from '../services/zatca'
import { publish } from '../utils/liveEvents'

const router = Router()
router.use(authenticate)
router.use(async (req, _res, next) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account is inactive', 403, 'FORBIDDEN')
  next()
})
const manage = requirePermission('can_manage_delivery'), settings = requirePermission('can_manage_delivery_settings'), settle = requirePermission('can_settle_rider_cash')
const money = z.number().finite().min(0).max(10000000).refine((n) => validMoneyPrecision(n), "Use the selected currency decimal precision")
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, 'Invalid date')
const zoneSchema = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(60), fee: money, minimumOrder: money, areas: z.array(z.string().trim().min(1).max(80)).max(100).default([]), etaMinutes: z.number().int().min(1).max(1440), feeVatRate: z.number().finite().min(0).max(100).nullable().default(null), feeTaxCategory: z.enum(['S', 'Z', 'E', 'O']).default('S'), feeTaxReasonCode: z.string().trim().max(60).optional().nullable(), feeTaxReason: z.string().trim().max(200).optional().nullable(), isActive: z.boolean().default(true) }).superRefine((b, c) => {
  if (b.feeTaxCategory !== 'S' && (b.feeVatRate !== 0 || !b.feeTaxReasonCode || !b.feeTaxReason)) c.addIssue({ code: z.ZodIssueCode.custom, path: ['feeVatRate'], message: 'Non-standard VAT needs a zero rate, reason code and reason' })
  if (b.feeTaxCategory === 'S' && b.feeVatRate === 0) c.addIssue({ code: z.ZodIssueCode.custom, path: ['feeVatRate'], message: 'Choose the correct zero/exempt/outside-scope category for a zero rate' })
})
const riderSchema = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(60), phone: z.string().trim().min(7).max(30).regex(/^\+?[0-9 ()-]+$/), active: z.boolean().default(true), userId: z.string().min(1).nullable().optional() })
const riderLogin = requirePermission('can_deliver_orders')
// a rider's login: an active user of this organization with the rider
// permission, not already linked to another rider
async function assertRiderLogin(organizationId: string, userId: string | null | undefined, riderId?: string) {
  if (!userId) return
  const user = await prisma.user.findFirst({ where: { id: userId, organizationId, isActive: true, roles: { some: { role: { permissions: { some: { permission: { key: 'can_deliver_orders' } } } } } } } })
  if (!user) throw new AppError('Choose an active user account with the Rider role', 400, 'RIDER_LOGIN_INVALID')
  if (await prisma.rider.count({ where: { userId, ...(riderId && { id: { not: riderId } }) } })) throw new AppError('That user account is already linked to another rider', 409, 'RIDER_LOGIN_IN_USE')
}
const riderUser = { user: { select: { id: true, firstName: true, lastName: true, email: true } } }
async function branchAccess(req: Parameters<typeof assertBranchAccess>[0], id: string) {
  await assertBranchAccess(req, id)
  const branch = await prisma.branch.findFirst({ where: { id, organizationId: req.user.organizationId, isActive: true } })
  if (!branch) throw new AppError('Branch is unavailable', 404, 'NOT_FOUND')
  return branch
}
router.get('/settings', requireAnyPermission('can_manage_delivery', 'can_manage_delivery_settings', 'can_settle_rider_cash', 'can_take_call_center_orders', 'can_use_pos', 'can_manage_orders'), async (req, res) => {
  const branch = await branchFilter(req, String(req.query.branchId || '') || undefined)
  const where = { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }
  const [zones, riders] = await Promise.all([prisma.deliveryZone.findMany({ where, orderBy: { name: 'asc' } }), prisma.rider.findMany({ where, orderBy: { name: 'asc' }, include: riderUser })])
  res.json({ zones, riders })
})
router.post('/zones', settings, async (req, res) => {
  const b = zoneSchema.parse(req.body), branch = await branchAccess(req, b.branchId)
  await validateDeliveryTax(prisma, req.user.organizationId, branch, b)
  const zone = await prisma.$transaction(async (tx) => {
    const saved = await tx.deliveryZone.create({ data: { ...b, areas: [...new Set(b.areas.map(normalizeArea))], organizationId: req.user.organizationId } })
    await logAudit(tx, { req, action: 'create_delivery_zone', module: 'delivery', branchId: b.branchId, resourceId: saved.id, newData: b })
    return saved
  }).catch((e) => { if (e.code === 'P2002') throw new AppError('Zone name already exists in this branch', 409, 'DUPLICATE'); throw e })
  res.status(201).json(zone)
})
router.put('/zones/:id', settings, async (req, res) => {
  const b = zoneSchema.parse(req.body), old = await prisma.deliveryZone.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!old) throw new AppError('Zone not found', 404, 'NOT_FOUND')
  if (old.branchId !== b.branchId) throw new AppError('A zone cannot be moved to another branch', 400, 'BRANCH_IMMUTABLE')
  const branch = await branchAccess(req, old.branchId)
  await validateDeliveryTax(prisma, req.user.organizationId, branch, b)
  const zone = await prisma.$transaction(async (tx) => {
    const saved = await tx.deliveryZone.update({ where: { id: old.id }, data: { ...b, areas: [...new Set(b.areas.map(normalizeArea))] } })
    await logAudit(tx, { req, action: 'update_delivery_zone', module: 'delivery', branchId: b.branchId, resourceId: old.id, oldData: old, newData: b })
    return saved
  }).catch((e) => { if (e.code === 'P2002') throw new AppError('Zone name already exists', 409, 'DUPLICATE'); throw e })
  res.json(zone)
})
router.post('/riders', settings, async (req, res) => {
  const b = riderSchema.parse(req.body); await branchAccess(req, b.branchId)
  await assertRiderLogin(req.user.organizationId, b.userId)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const rider = await prisma.rider.create({ data: { ...b, phone: normalizePhone(b.phone, org.country), organizationId: org.id }, include: riderUser })
  await logAudit(prisma, { req, action: 'create_rider', module: 'delivery', branchId: b.branchId, resourceId: rider.id, newData: b })
  res.status(201).json(rider)
})
router.put('/riders/:id', settings, async (req, res) => {
  const b = riderSchema.parse(req.body), old = await prisma.rider.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!old) throw new AppError('Rider not found', 404, 'NOT_FOUND')
  if (old.branchId !== b.branchId) throw new AppError('A rider cannot be moved between branches', 400, 'BRANCH_IMMUTABLE')
  await branchAccess(req, old.branchId)
  await assertRiderLogin(req.user.organizationId, b.userId, old.id)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const rider = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Rider" WHERE id = ${old.id} FOR UPDATE`
    if (!b.active && await tx.customerOrder.count({ where: { riderId: old.id, deliveryStatus: { in: ['assigned', 'picked_up'] }, status: { in: ['open', 'completed'] } } })) throw new AppError('Reassign or finish this rider’s active deliveries first', 409, 'RIDER_HAS_DELIVERIES')
    const updated = await tx.rider.update({ where: { id: old.id }, data: { ...b, phone: normalizePhone(b.phone, org.country) }, include: riderUser })
    await logAudit(tx, { req, action: 'update_rider', module: 'delivery', branchId: b.branchId, resourceId: old.id, newData: b })
    return updated
  })
  res.json(rider)
})
// user accounts that can be linked to a rider (they hold the Rider role)
router.get('/rider-accounts', settings, async (req, res) => {
  const users = await prisma.user.findMany({ where: { organizationId: req.user.organizationId, isActive: true, roles: { some: { role: { permissions: { some: { permission: { key: 'can_deliver_orders' } } } } } } }, select: { id: true, firstName: true, lastName: true, email: true, riderProfile: { select: { id: true, name: true } } }, orderBy: { firstName: 'asc' } })
  res.json({ data: users })
})

// ── Rider login: only the deliveries assigned to this rider ─────────────────
async function myRider(req: Parameters<typeof assertBranchAccess>[0]) {
  const rider = await prisma.rider.findFirst({ where: { userId: req.user.id, organizationId: req.user.organizationId, active: true } })
  if (!rider) throw new AppError('Your account is not linked to an active rider. Ask your manager to link it in Delivery → Zones & riders.', 404, 'NOT_A_RIDER')
  return rider
}
// what a rider needs on the road; no other customers, prices or payments
const riderOrderSelect = {
  id: true, orderNo: true, status: true, deliveryStatus: true, deliveryPaymentMode: true, totalAmount: true, deliveryFee: true,
  customerName: true, customerPhone: true, deliveryAddress: true, deliveryArea: true, deliveryZoneName: true, notes: true,
  dispatchedAt: true, deliveredAt: true, deliveryFailureReason: true, createdAt: true, estimatedReadyAt: true,
  branch: { select: { id: true, name: true, phone: true, address: true } },
  items: { where: { status: { not: 'cancelled' } }, orderBy: { createdAt: 'asc' as const }, select: { id: true, dishName: true, quantity: true, selection: true, notes: true, status: true, held: true } },
} as const
router.get('/me', riderLogin, async (req, res) => {
  const rider = await myRider(req)
  const since = new Date(Date.now() - 16 * 3600000)
  const orders = await prisma.customerOrder.findMany({
    where: { organizationId: req.user.organizationId, orderType: 'delivery', riderId: rider.id, status: { in: ['open', 'completed'] }, OR: [{ deliveryStatus: { in: ['assigned', 'picked_up'] } }, { deliveryStatus: { in: ['delivered', 'failed'] }, updatedAt: { gte: since } }] },
    select: riderOrderSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
  })
  const cash = await prisma.riderCashCollection.aggregate({ where: { riderId: rider.id, settlementId: null }, _sum: { amount: true }, _count: true })
  res.json({ rider: { id: rider.id, name: rider.name, branchId: rider.branchId }, orders, cashToHandIn: { amount: cash._sum.amount ?? 0, count: cash._count } })
})
router.post('/me/orders/:id/status', riderLogin, async (req, res) => {
  const rider = await myRider(req)
  const b = z.object({ status: z.enum(['picked_up', 'delivered', 'failed']), reason: z.string().trim().max(300).optional(), cashCollected: money.optional() }).parse(req.body)
  const result = await transitionDelivery(req, req.params.id, b, { asRiderId: rider.id })
  if (!result.duplicate) { publishOrder(result.order, `delivery_${b.status}`); if (b.status === 'delivered') publish({ topic: 'sale', action: 'updated', organizationId: req.user.organizationId, branchId: result.order.branchId }) }
  let invoicePending = false
  if (result.order.status === 'completed' && b.status === 'delivered') {
    const doc = await issueForOrder(result.order.id, 'invoice').catch((e) => { console.error('[delivery] invoice pending', result.order.id, e); return undefined })
    invoicePending = doc === undefined
  }
  res.json({ duplicate: result.duplicate, invoicePending, order: await prisma.customerOrder.findUniqueOrThrow({ where: { id: result.order.id }, select: riderOrderSelect }) })
})

router.get('/board', manage, async (req, res) => {
  const branch = await branchFilter(req, String(req.query.branchId || '') || undefined), ctx = await formatContextFor(req.user.organizationId)
  const date = dateSchema.parse(req.query.date || todayInZone(ctx).toISOString().slice(0, 10))
  const page = z.coerce.number().int().min(1).max(100000).default(1).parse(req.query.page)
  const where = { organizationId: req.user.organizationId, ...(branch && { branchId: branch }), orderType: 'delivery', status: { in: ['pending', 'open', 'completed'] }, OR: [{ createdAt: momentRange(date, date, ctx) }, { deliveryStatus: { not: 'delivered' } }, { deliveryStatus: null }] }
  const [rows, total] = await Promise.all([
    prisma.customerOrder.findMany({ where, include: orderInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 100, take: 100 }),
    prisma.customerOrder.count({ where }),
  ])
  res.json({ data: rows, hasMore: page * 100 < total, page, total, totalPages: Math.max(1, Math.ceil(total / 100)) })
})
router.get('/orders/:id', manage, async (req, res) => {
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId, orderType: 'delivery' }, include: { ...orderInclude, deliveryEvents: { orderBy: { createdAt: 'asc' } }, riderCollection: { include: { settlement: true } } } })
  if (!order) throw new AppError('Delivery order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  res.json(order)
})
router.post('/orders/:id/status', manage, async (req, res) => {
  const b = z.object({ status: z.enum(['assigned', 'picked_up', 'delivered', 'failed']), riderId: z.string().optional(), reason: z.string().trim().max(300).optional(), cashCollected: money.optional() }).parse(req.body)
  const result = await transitionDelivery(req, req.params.id, b)
  if (!result.duplicate) { publishOrder(result.order, `delivery_${b.status}`); if (b.status === 'delivered') publish({ topic: 'sale', action: 'updated', organizationId: req.user.organizationId, branchId: result.order.branchId }) }
  // the sale is committed either way; a failed e-invoice is listed under
  // Settings → ZATCA → Not issued and can be issued again from there
  let invoicePending = false
  if (result.order.status === 'completed' && b.status === 'delivered') {
    const doc = await issueForOrder(result.order.id, 'invoice').catch((e) => { console.error('[delivery] invoice pending', result.order.id, e); return undefined })
    invoicePending = doc === undefined
  }
  res.json({ ...result, invoicePending, order: await prisma.customerOrder.findUniqueOrThrow({ where: { id: result.order.id }, include: orderInclude }) })
})
router.get('/cash', settle, async (req, res) => {
  const branch = await branchFilter(req, String(req.query.branchId || '') || undefined), ctx = await formatContextFor(req.user.organizationId)
  const date = dateSchema.parse(req.query.date || todayInZone(ctx).toISOString().slice(0, 10)), day = new Date(`${date}T00:00:00Z`)
  const where = { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }
  const [collections, settlements] = await Promise.all([
    prisma.riderCashCollection.findMany({ where: { ...where, OR: [{ businessDate: day }, { settlementId: null }] }, include: { rider: true, order: { select: { orderNo: true, customerName: true } } }, orderBy: { collectedAt: 'asc' } }),
    prisma.riderSettlement.findMany({ where: { ...where, businessDate: day }, include: { rider: true, collections: { select: { id: true, amount: true, orderId: true } } }, orderBy: { settledAt: 'desc' } }),
  ])
  res.json({ collections, settlements, date })
})
router.post('/settlements', settle, async (req, res) => {
  const b = z.object({ requestId: z.string().uuid(), riderId: z.string().min(1), collectionIds: z.array(z.string().min(1)).min(1).max(200).refine((v) => new Set(v).size === v.length, 'Duplicate collection'), countedCash: money, notes: z.string().trim().max(500).optional() }).parse(req.body)
  const result = await settleRiderCash(req, b)
  res.status(result.duplicate ? 200 : 201).json(result)
})
router.get('/settlements/:id/report', settle, async (req, res) => {
  const s = await prisma.riderSettlement.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, include: { rider: true, collections: { include: { order: { select: { orderNo: true } } } } } })
  if (!s) throw new AppError('Settlement not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, s.branchId)
  const [org, branch, ctx] = await Promise.all([prisma.organization.findUniqueOrThrow({ where: { id: s.organizationId } }), prisma.branch.findUniqueOrThrow({ where: { id: s.branchId } }), formatContextFor(s.organizationId, req.user.id)])
  const report: ProReport = { key: 'rider-settlement', eyebrow: `RIDER CASH HANDOVER ${s.number}`, headline: s.rider.name, orgName: org.name, currency: org.currency, scopeLabel: branch.name, periodLabel: formatDateTime(s.settledAt, ctx), generatedAt: new Date().toISOString(), summaryLine: [`Till: ${s.tillSessionId}`, s.notes || ''].filter(Boolean).join(' · '), kpis: [{ label: 'Expected cash', value: s.expectedCash, format: 'money' }, { label: 'Handed in', value: s.countedCash, format: 'money' }, { label: 'Difference', value: s.difference, format: 'money' }], sections: [{ type: 'table', id: 'collections', title: 'Customer cash collected', columns: [{ key: 'orderNo', label: 'Order' }, { key: 'collectedAt', label: 'Collected' }, { key: 'amount', label: 'Cash', format: 'money' }], rows: s.collections.map((c) => ({ orderNo: c.order.orderNo, collectedAt: formatDateTime(c.collectedAt, ctx), amount: c.amount })) }] }
  sendProReport(res, String(req.query.format || 'json'), report)
})
export default router
