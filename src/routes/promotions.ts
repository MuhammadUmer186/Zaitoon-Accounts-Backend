import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { recalcOrderTotals } from '../utils/menu'
import { assertBranchAccess } from '../utils/branchScope'
import { assertBillEditable, lockOrder, orderInclude, publishOrder } from './orders'

// Promotions are set up by menu managers and priced by the server; staff
// only enter coupon codes.
export const promotionsRouter = Router()
const active = async (req: Request, _res: Response, next: NextFunction) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
}
promotionsRouter.use(authenticate, active)
const manage = requirePermission('can_manage_menu')
const view = requireAnyPermission('can_manage_menu', 'can_manage_orders', 'can_use_pos')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const schema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['percent', 'fixed', 'buy_x_get_y', 'free_item_over', 'price_override']),
  value: z.number().finite().min(0).max(10000000).default(0),
  scope: z.enum(['all', 'dishes', 'categories']).default('all'),
  dishIds: z.array(z.string().min(1)).max(200).default([]), categoryIds: z.array(z.string().min(1)).max(100).default([]),
  branchIds: z.array(z.string().min(1)).max(100).default([]), daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  startTime: hhmm.nullable().optional(), endTime: hhmm.nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
  customerTags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  couponCode: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9-]+$/).nullable().optional(),
  buyQuantity: z.number().int().min(1).max(50).nullable().optional(), getQuantity: z.number().int().min(1).max(50).nullable().optional(),
  minimumSpend: z.number().finite().min(0).max(10000000).nullable().optional(), freeDishId: z.string().min(1).nullable().optional(),
  priority: z.number().int().min(-100).max(100).default(0), stackable: z.boolean().default(false), isActive: z.boolean().default(true),
}).superRefine((b, c) => {
  const issue = (path: string, message: string) => c.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })
  if (b.type === 'percent' && (b.value <= 0 || b.value > 100)) issue('value', 'A percentage is between 0 and 100')
  if (b.type === 'fixed' && b.value <= 0) issue('value', 'Enter the amount off')
  if (b.type === 'buy_x_get_y' && (!b.buyQuantity || !b.getQuantity)) issue('buyQuantity', 'Enter how many to buy and how many are free')
  if (b.type === 'free_item_over' && (!b.freeDishId || !b.minimumSpend)) issue('freeDishId', 'Choose the free dish and the spend that earns it')
  if (b.type === 'price_override' && b.scope === 'all') issue('scope', 'A special price applies to chosen dishes or categories')
  if (b.scope === 'dishes' && !b.dishIds.length) issue('dishIds', 'Choose the dishes')
  if (b.scope === 'categories' && !b.categoryIds.length) issue('categoryIds', 'Choose the categories')
  if (!!b.startTime !== !!b.endTime) issue('endTime', 'Enter both start and end times, or neither')
  if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) issue('endsAt', 'The end date must be after the start date')
})

async function assertOwned(orgId: string, b: z.infer<typeof schema>) {
  const [dishes, categories, branches] = await Promise.all([
    prisma.dish.count({ where: { organizationId: orgId, id: { in: [...b.dishIds, ...(b.freeDishId ? [b.freeDishId] : [])] } } }),
    prisma.menuCategory.count({ where: { organizationId: orgId, id: { in: b.categoryIds } } }),
    prisma.branch.count({ where: { organizationId: orgId, id: { in: b.branchIds } } }),
  ])
  if (dishes !== new Set([...b.dishIds, ...(b.freeDishId ? [b.freeDishId] : [])]).size || categories !== b.categoryIds.length || branches !== b.branchIds.length) throw new AppError('A dish, category or branch is not in this organization', 400, 'VALIDATION_ERROR')
}
const data = (b: z.infer<typeof schema>) => ({ ...b, couponCode: b.couponCode ? b.couponCode.toUpperCase() : null, customerTags: b.customerTags.map((t) => t.toLowerCase()), startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null })

promotionsRouter.get('/', view, async (req: Request, res: Response) => {
  res.json({ data: await prisma.promotion.findMany({ where: { organizationId: req.user.organizationId }, orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { name: 'asc' }] }) })
})
promotionsRouter.post('/', manage, async (req: Request, res: Response) => {
  const b = schema.parse(req.body)
  await assertOwned(req.user.organizationId, b)
  const saved = await prisma.$transaction(async (tx) => {
    const p = await tx.promotion.create({ data: { ...data(b), organizationId: req.user.organizationId } })
    await logAudit(tx, { req, action: 'create_promotion', module: 'menu', resourceType: 'promotion', resourceId: p.id, resourceRef: p.name, newData: b })
    return p
  }).catch((e) => { if ((e as { code?: string }).code === 'P2002') throw new AppError('That coupon code is already used', 409, 'DUPLICATE'); throw e })
  res.status(201).json(saved)
})
promotionsRouter.put('/:id', manage, async (req: Request, res: Response) => {
  const b = schema.parse(req.body)
  const old = await prisma.promotion.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!old) throw new AppError('Promotion not found', 404, 'NOT_FOUND')
  await assertOwned(req.user.organizationId, b)
  const saved = await prisma.$transaction(async (tx) => {
    const p = await tx.promotion.update({ where: { id: old.id }, data: data(b) })
    await logAudit(tx, { req, action: 'update_promotion', module: 'menu', resourceType: 'promotion', resourceId: p.id, resourceRef: p.name, oldData: old, newData: b })
    return p
  }).catch((e) => { if ((e as { code?: string }).code === 'P2002') throw new AppError('That coupon code is already used', 409, 'DUPLICATE'); throw e })
  res.json(saved)
})

// coupon codes on an open order: /orders/:id/coupon
export const couponRouter = Router()
couponRouter.use(authenticate, active)
async function orderFor(req: Request) {
  const o = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!o) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, o.branchId)
  return o
}
couponRouter.post('/:id/coupon', requirePermission('can_manage_orders'), async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim().min(3).max(30) }).parse(req.body)
  const order = await orderFor(req)
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (!['pending', 'open'].includes(fresh.status)) throw new AppError('Coupons apply to open orders', 409, 'INVALID_STATUS')
    await assertBillEditable(tx, order.id)
    const promo = await tx.promotion.findFirst({ where: { organizationId: order.organizationId, couponCode: code.toUpperCase(), isActive: true } })
    if (!promo) throw new AppError('Coupon not found or no longer active', 404, 'COUPON_NOT_FOUND')
    await tx.customerOrder.update({ where: { id: order.id }, data: { couponCode: promo.couponCode } })
    const totals = await recalcOrderTotals(tx, order.id)
    const applied = (totals.promotions as { id: string }[] | null) ?? []
    if (!applied.some((a) => a.id === promo.id)) throw new AppError('This coupon does not apply to this bill (dishes, time, branch, customer or minimum spend)', 409, 'COUPON_NOT_APPLICABLE')
    await logAudit(tx, { req, action: 'apply_coupon', module: 'orders', resourceType: 'customer_order', resourceId: order.id, branchId: order.branchId, newData: { code: promo.couponCode, promotionId: promo.id } })
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  publishOrder(order, 'coupon_applied'); res.json(updated)
})
couponRouter.delete('/:id/coupon', requirePermission('can_manage_orders'), async (req: Request, res: Response) => {
  const order = await orderFor(req)
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (!['pending', 'open'].includes(fresh.status)) throw new AppError('Coupons apply to open orders', 409, 'INVALID_STATUS')
    await assertBillEditable(tx, order.id)
    await tx.customerOrder.update({ where: { id: order.id }, data: { couponCode: null } })
    await recalcOrderTotals(tx, order.id)
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  publishOrder(order, 'coupon_removed'); res.json(updated)
})

// attach (or detach) the customer before payment, so customer-tag promotions,
// loyalty and the house account are priced on the bill the cashier sees
couponRouter.put('/:id/customer', requirePermission('can_manage_orders'), async (req: Request, res: Response) => {
  const { customerId } = z.object({ customerId: z.string().min(1).nullable() }).parse(req.body)
  const order = await orderFor(req)
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (!['pending', 'open'].includes(fresh.status)) throw new AppError('The customer can only change on an open order', 409, 'INVALID_STATUS')
    await assertBillEditable(tx, order.id)
    const customer = customerId ? await tx.customer.findFirst({ where: { id: customerId, organizationId: order.organizationId } }) : null
    if (customerId && !customer) throw new AppError('Customer not found', 404, 'NOT_FOUND')
    await tx.customerOrder.update({ where: { id: order.id }, data: { customerId: customer?.id ?? null, ...(customer && !fresh.customerName && { customerName: customer.name }), ...(customer && !fresh.customerPhone && { customerPhone: customer.phone }) } })
    await recalcOrderTotals(tx, order.id)
    await logAudit(tx, { req, action: customer ? 'attach_customer' : 'detach_customer', module: 'orders', resourceType: 'customer_order', resourceId: order.id, branchId: order.branchId, oldData: { customerId: fresh.customerId }, newData: { customerId: customer?.id ?? null } })
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  publishOrder(order, 'customer_changed'); res.json(updated)
})
