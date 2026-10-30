import { readyForPayment, assertReadyForPayment } from '../services/orderPaymentPolicy'
import crypto from 'node:crypto'
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { rateLimit } from '../middleware/rateLimit'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { publish } from '../utils/liveEvents'
import { ensureShifts, currentShift, nextShift, nextOrderNo, recalcOrderTotals } from '../utils/menu'
import { brandingLogoUrl } from './orgs'
import { guestItems, guestMenuCategories, placeOrderSchema, priceGuestCart, publicOrder, DishesUnavailable } from './public'
import { createIntent, paymentStatus, publicIntent, systemRequest } from '../services/payments'
import { createChecks } from '../services/orderChecks'

// Customer-facing checkout: the table QR bill (view, split, pay), the
// customer display next to the till and the self-service kiosk. Devices are
// paired with an unguessable link token; only its hash is stored.
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')


// ── Staff: pair, list, revoke devices; show an order on a display ──────────
export const devicesRouter = Router()
devicesRouter.use(authenticate, async (req: Request, _res: Response, next: NextFunction) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
})
const manageDevices = requirePermission('can_manage_checkout_devices')
const cashier = requireAnyPermission('can_manage_orders', 'can_use_pos')
const deviceView = (d: { id: string; branchId: string; kind: string; name: string; isActive: boolean; showOrderId: string | null; lastSeenAt: Date | null; createdAt: Date }) =>
  ({ id: d.id, branchId: d.branchId, kind: d.kind, name: d.name, isActive: d.isActive, showOrderId: d.showOrderId, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt })

devicesRouter.get('/', cashier, async (req: Request, res: Response) => {
  const branch = await branchFilter(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined)
  const rows = await prisma.checkoutDevice.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] })
  res.json({ data: rows.map(deviceView) })
})
devicesRouter.post('/', manageDevices, async (req: Request, res: Response) => {
  const b = z.object({ branchId: z.string().min(1), kind: z.enum(['customer_display', 'kiosk']), name: z.string().trim().min(1).max(60) }).parse(req.body)
  await assertBranchAccess(req, b.branchId)
  if (!await prisma.branch.count({ where: { id: b.branchId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  const token = crypto.randomBytes(24).toString('base64url')
  const device = await prisma.checkoutDevice.create({ data: { organizationId: req.user.organizationId, branchId: b.branchId, kind: b.kind, name: b.name, tokenHash: hash(token), createdBy: req.user.id } })
  await logAudit(prisma, { req, action: 'pair_checkout_device', module: 'settings', resourceType: 'checkout_device', resourceId: device.id, resourceRef: b.name, branchId: b.branchId, newData: { kind: b.kind, name: b.name } })
  // the link is shown once; only its hash is kept
  res.status(201).json({ ...deviceView(device), token, path: `/${b.kind === 'kiosk' ? 'kiosk' : 'display'}/${token}` })
})
devicesRouter.delete('/:id', manageDevices, async (req: Request, res: Response) => {
  const d = await prisma.checkoutDevice.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!d) throw new AppError('Device not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, d.branchId)
  const updated = await prisma.checkoutDevice.update({ where: { id: d.id }, data: { isActive: false, showOrderId: null } })
  await logAudit(prisma, { req, action: 'revoke_checkout_device', module: 'settings', resourceType: 'checkout_device', resourceId: d.id, resourceRef: d.name, branchId: d.branchId })
  res.json(deviceView(updated))
})
// PUT /checkout-devices/:id/show { orderId | null } — the cashier puts the
// current bill on the customer display (same branch only)
devicesRouter.put('/:id/show', cashier, async (req: Request, res: Response) => {
  const { orderId } = z.object({ orderId: z.string().min(1).nullable() }).parse(req.body)
  const d = await prisma.checkoutDevice.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId, kind: 'customer_display', isActive: true } })
  if (!d) throw new AppError('Display not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, d.branchId)
  if (orderId && !await prisma.customerOrder.count({ where: { id: orderId, organizationId: req.user.organizationId, branchId: d.branchId } })) throw new AppError('Order not found at this display’s branch', 404, 'NOT_FOUND')
  await prisma.checkoutDevice.update({ where: { id: d.id }, data: { showOrderId: orderId } })
  publish({ topic: 'display', action: 'changed', organizationId: d.organizationId, branchId: d.branchId, deviceId: d.id } as never)
  res.json({ shown: orderId })
})

// ── Public ──────────────────────────────────────────────────────────────────
export const publicCheckoutRouter = Router()

async function deviceByToken(token: string, kind: 'customer_display' | 'kiosk') {
  const d = token ? await prisma.checkoutDevice.findUnique({ where: { tokenHash: hash(token) } }) : null
  if (!d || !d.isActive || d.kind !== kind) throw new AppError('This screen link is no longer valid', 404, 'NOT_FOUND')
  const [branch, org] = await Promise.all([
    prisma.branch.findFirst({ where: { id: d.branchId, isActive: true } }),
    prisma.organization.findFirst({ where: { id: d.organizationId, isActive: true } }),
  ])
  if (!branch || !org) throw new AppError('This screen link is no longer valid', 404, 'NOT_FOUND')
  // a heartbeat at most once a minute
  if (!d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() > 60_000) await prisma.checkoutDevice.update({ where: { id: d.id }, data: { lastSeenAt: new Date() } })
  return { device: d, branch, org }
}
const restaurant = (org: { name: string; tradeName: string | null; currency: string; multiBranch: boolean; logoPath: string | null }, branchName: string) =>
  ({ name: org.tradeName || org.name, currency: org.currency, logoUrl: brandingLogoUrl(org as never), branch: org.multiBranch ? branchName : null })

// Table QR: the bill, its checks, whether it can be paid here
async function tableByToken(token: string) {
  const table = await prisma.diningTable.findUnique({ where: { orderToken: token }, include: { branch: true, organization: true } })
  if (!table || !table.isActive || !table.branch.isActive || !table.organization.isActive) throw new AppError('This table QR code is not active. Please ask the staff for help.', 404, 'TABLE_NOT_FOUND')
  return table
}
async function tableCheckout(token: string) {
  const table = await tableByToken(token)
  const order = await prisma.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' }, include: { ...guestItems, checks: { orderBy: { number: 'asc' } } } })
  const payments = await paymentStatus(prisma, table.organizationId)
  const canPay = payments.active && payments.channels.includes('qr')
  return { table, order, canPay }
}
publicCheckoutRouter.get('/tables/:token', rateLimit('checkout-view', 240, 60_000), async (req: Request, res: Response) => {
  const { order, canPay } = await tableCheckout(req.params.token)
  const accepted = !!order && readyForPayment(order)
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    order: publicOrder(order),
    checks: (order?.checks ?? []).map((c) => ({ id: c.id, number: c.number, label: c.label, totalAmount: c.totalAmount, status: c.status })),
    // Acceptance opens checkout; full settlement releases kitchen preparation.
    payable: canPay && accepted,
    paymentsAvailable: canPay,
    canSplit: canPay && accepted && !!order && !order.checks.length,
  })
})
// POST /public/checkout/tables/:token/split — the guests split the bill
publicCheckoutRouter.post('/tables/:token/split', rateLimit('checkout-split', 10, 60_000), async (req: Request, res: Response) => {
  const b = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('equal'), count: z.number().int().min(2).max(12) }),
    z.object({ mode: z.literal('items'), groups: z.array(z.object({ label: z.string().trim().min(1).max(40), itemIds: z.array(z.string().min(1)).min(1).max(200) })).min(2).max(12) }),
  ]).parse(req.body)
  const { table, order, canPay } = await tableCheckout(req.params.token)
  if (!order) throw new AppError('There is no open bill on this table.', 404, 'ORDER_NOT_FOUND')
  if (!canPay) throw new AppError('Paying from the table is not available here. Please pay at the counter.', 409, 'PAYMENTS_UNAVAILABLE')
  assertReadyForPayment(order)
  await prisma.$transaction(async (tx) => {
    const sys = await systemRequest(tx, table.organizationId)
    if (await tx.orderCheck.count({ where: { orderId: order.id } })) throw new AppError('This bill is already split', 409, 'CHECKS_EXIST')
    await createChecks(tx, sys, order.id, b.mode === 'equal' ? { mode: 'equal', count: b.count, discountAmount: 0 } : { mode: 'items', checks: b.groups.map((g) => ({ label: g.label, itemIds: g.itemIds })), discountAmount: 0 })
  })
  publish({ topic: 'order', action: 'checks_created', organizationId: table.organizationId, branchId: table.branchId, tableId: table.id, orderId: order.id, orderNo: order.orderNo, tableName: table.name })
  const after = await tableCheckout(req.params.token)
  res.status(201).json({ checks: (after.order?.checks ?? []).map((c) => ({ id: c.id, number: c.number, label: c.label, totalAmount: c.totalAmount, status: c.status })) })
})
// POST /public/checkout/tables/:token/pay { checkId? } — start paying the
// whole bill or one check; the amount comes from the server
publicCheckoutRouter.post('/tables/:token/pay', rateLimit('checkout-pay', 20, 60_000), async (req: Request, res: Response) => {
  const { checkId } = z.object({ checkId: z.string().min(1).optional().nullable() }).parse(req.body ?? {})
  const { table, order, canPay } = await tableCheckout(req.params.token)
  if (!order) throw new AppError('There is no open bill on this table.', 404, 'ORDER_NOT_FOUND')
  if (!canPay) throw new AppError('Paying from the table is not available here. Please pay at the counter.', 409, 'PAYMENTS_UNAVAILABLE')
  assertReadyForPayment(order)
  if (checkId && !order.checks.some((c) => c.id === checkId)) throw new AppError('Check not found', 404, 'NOT_FOUND')
  const { intent, accessToken } = await createIntent({ organizationId: table.organizationId, branchId: table.branchId, orderId: order.id, checkId: checkId ?? null, channel: 'qr' })
  res.status(201).json({ ...publicIntent(intent), accessToken, payPath: `/pay/${intent.id}?t=${accessToken}` })
})

// Customer display: what the cashier is ringing up, and the payment state
publicCheckoutRouter.get('/display/:token', rateLimit('display', 240, 60_000), async (req: Request, res: Response) => {
  const { device, branch, org } = await deviceByToken(req.params.token, 'customer_display')
  res.setHeader('Cache-Control', 'no-store')
  const base = { restaurant: restaurant(org, branch.name), device: { name: device.name } }
  if (!device.showOrderId) return res.json({ ...base, order: null })
  const order = await prisma.customerOrder.findFirst({ where: { id: device.showOrderId, branchId: device.branchId }, include: { items: { where: { status: { not: 'cancelled' } }, orderBy: { createdAt: 'asc' } } } })
  if (!order) return res.json({ ...base, order: null })
  const intent = await prisma.paymentIntent.findFirst({ where: { orderId: order.id, status: { in: ['pending', 'succeeded', 'failed'] } }, orderBy: { createdAt: 'desc' } })
  res.json({
    ...base,
    order: {
      orderNo: order.orderNo, status: order.status, itemsTotal: order.itemsTotal, discountAmount: order.discountAmount, promotionAmount: order.promotionAmount,
      deliveryFee: order.deliveryFee, vatAmount: order.vatAmount, vatRate: order.vatRate, totalAmount: order.totalAmount, changeAmount: order.changeAmount, amountTendered: order.amountTendered,
      promotions: ((order.promotions as { name: string; amount: number }[] | null) ?? []).map((p) => ({ name: p.name, amount: p.amount })),
      lines: order.items.map((i) => ({ id: i.id, name: i.dishName, quantity: i.quantity, lineTotal: i.lineTotal })),
    },
    payment: intent ? { status: intent.status, amount: intent.amount, channel: intent.channel } : null,
  })
})

// ── Kiosk ───────────────────────────────────────────────────────────────────
publicCheckoutRouter.get('/kiosk/:token/menu', rateLimit('kiosk-menu', 240, 60_000), async (req: Request, res: Response) => {
  const { branch, org } = await deviceByToken(req.params.token, 'kiosk')
  const shifts = await ensureShifts(prisma, org.id)
  const shift = currentShift(shifts, org.timezone)
  const payments = await paymentStatus(prisma, org.id)
  const upcoming = shift ? null : nextShift(shifts, org.timezone)
  res.json({
    restaurant: restaurant(org, branch.name),
    vat: { enabled: branch.vatEnabled, rate: branch.vatRate },
    shift: shift && { id: shift.id, name: shift.name },
    nextShift: upcoming && { name: upcoming.name, startTime: upcoming.startTime },
    payOnline: payments.active && payments.channels.includes('kiosk'),
    categories: shift ? await guestMenuCategories(org.id, branch.id, shift.id) : [],
  })
})
const kioskOrderSchema = placeOrderSchema.extend({
  requestId: z.string().uuid(),
  customerName: z.string().trim().min(1).max(40),
  orderType: z.enum(['takeaway', 'dine_in']).default('takeaway'),
  payment: z.enum(['online', 'counter']),
})
const kioskView = (o: { id: string; orderNo: number; status: string; totalAmount: number; deliveryPaymentMode: string | null }, intent?: { status: string } | null) =>
  ({ id: o.id, orderNo: o.orderNo, status: o.status, totalAmount: o.totalAmount, payment: o.status === 'completed' ? 'paid' : o.deliveryPaymentMode === 'prepaid' ? 'online' : 'counter', paymentStatus: intent?.status ?? null })

// POST /public/checkout/kiosk/:token/orders — the guest's order. Paying
// online: it reaches the kitchen once the payment is verified. Paying at the
// counter: staff accept it like an online order and take the money.
publicCheckoutRouter.post('/kiosk/:token/orders', rateLimit('kiosk-order', 20, 60_000), async (req: Request, res: Response) => {
  const body = kioskOrderSchema.parse(req.body)
  const { device, branch, org } = await deviceByToken(req.params.token, 'kiosk')
  const shift = currentShift(await ensureShifts(prisma, org.id), org.timezone)
  if (!shift) throw new AppError('Ordering is closed right now.', 400, 'NO_ACTIVE_SHIFT')
  const payments = await paymentStatus(prisma, org.id)
  if (body.payment === 'online' && !(payments.active && payments.channels.includes('kiosk'))) throw new AppError('Card payment is not available on this kiosk. Please pay at the counter.', 409, 'PAYMENTS_UNAVAILABLE')
  let lines: Awaited<ReturnType<typeof priceGuestCart>>
  try { lines = await priceGuestCart(org.id, branch.id, shift.id, body.items, body.customerName, 'pending') } catch (e) {
    if (!(e instanceof DishesUnavailable)) throw e
    return res.status(409).json({ message: e.message, code: 'DISH_UNAVAILABLE', unavailableDishIds: e.dishIds })
  }
  // the same request id always returns the same order (a retried tap)
  const id = `kiosk_${hash(`${device.id}:${body.requestId}`).slice(0, 24)}`
  for (let attempt = 0; ; attempt++) {
    try {
      let created = false
      const order = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`
        const existing = await tx.customerOrder.findUnique({ where: { id } })
        if (existing) return existing
        await tx.customerOrder.create({ data: {
          id, organizationId: org.id, branchId: branch.id, shiftId: shift.id, orderNo: await nextOrderNo(tx, org.id, branch.id),
          orderType: body.orderType, source: 'kiosk', status: 'pending', customerName: body.customerName,
          // "prepaid": waiting for the kiosk card payment
          deliveryPaymentMode: body.payment === 'online' ? 'prepaid' : null,
          items: { create: lines },
        } })
        await recalcOrderTotals(tx, id)
        created = true
        return tx.customerOrder.findUniqueOrThrow({ where: { id } })
      })
      if (created) publish({ topic: 'order', action: 'online_received', organizationId: org.id, branchId: branch.id, orderId: order.id, orderNo: order.orderNo, tableId: null, tableName: null })
      let pay: { payPath: string; intentId: string } | null = null
      if (body.payment === 'online' && order.status === 'pending') {
        const { intent, accessToken } = await createIntent({ organizationId: org.id, branchId: branch.id, orderId: order.id, channel: 'kiosk' })
        pay = { payPath: `/pay/${intent.id}?t=${accessToken}`, intentId: intent.id }
      }
      return res.status(created ? 201 : 200).json({ order: kioskView(order), ...(pay && { pay }) })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002' && attempt < 4) continue
      throw err
    }
  }
})
// GET /public/checkout/kiosk/:token/orders/:id — status after paying
publicCheckoutRouter.get('/kiosk/:token/orders/:id', rateLimit('kiosk-status', 240, 60_000), async (req: Request, res: Response) => {
  const { device } = await deviceByToken(req.params.token, 'kiosk')
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, branchId: device.branchId, source: 'kiosk', createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } } })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  const intent = await prisma.paymentIntent.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ order: kioskView(order, intent) })
})
// POST /public/checkout/kiosk/:token/orders/:id/counter — card failed or the
// guest changed their mind: pay at the counter instead
publicCheckoutRouter.post('/kiosk/:token/orders/:id/counter', rateLimit('kiosk-status', 60, 60_000), async (req: Request, res: Response) => {
  const { device } = await deviceByToken(req.params.token, 'kiosk')
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, branchId: device.branchId, source: 'kiosk', status: 'pending' } })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await prisma.paymentIntent.updateMany({ where: { orderId: order.id, status: { in: ['created', 'pending'] } }, data: { status: 'cancelled', failureReason: 'Guest chose to pay at the counter' } })
  const updated = await prisma.customerOrder.update({ where: { id: order.id }, data: { deliveryPaymentMode: null } })
  publish({ topic: 'order', action: 'online_received', organizationId: order.organizationId, branchId: order.branchId, orderId: order.id, orderNo: order.orderNo, tableId: null, tableName: null })
  res.json({ order: kioskView(updated) })
})

