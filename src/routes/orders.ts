import { moneyTolerance, validMoneyPrecision } from '../utils/money'
import { roundMoney as regionalRoundMoney } from '../utils/money'
import { estimatedReadyAfterPayment } from '../services/orderPaymentPolicy'
import { assertCounter } from '../services/posCounters'
import { recordPayment, orderPayments } from '../services/tills'
import { authorizePos, resolveVoidReason } from '../services/posSecurity'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission, requireAnyPermission } from '../middleware/authorize'
import { getUserPermissions } from '../utils/permissions'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { logAudit } from '../utils/audit'
import { AWAITING, ITEM_STATUSES, recalcOrderTotals } from '../utils/menu'
import { publish } from '../utils/liveEvents'
import { addOrderToDailySale, removeOrderFromDailySale } from '../services/orderSales'
import { makeReviewCode } from '../utils/reviewCode'
import { costAndConsumeOrder, restoreOrderStock, writeOffCancelledItem } from '../services/foodCost'
import { issueForOrder } from '../services/zatca'
import { creditTenders, debitTenders, earnLoyalty, reverseLoyaltyEarn } from '../services/tenders'
import { recordVisit, reverseVisit } from '../services/customers'
import { assertPromotionCombination } from '../services/promotions'
import { cancelOpenIntents, refundIntentsForOrder } from '../services/payments'

const router = Router()

router.use(authenticate)

const canOrders = requirePermission('can_manage_orders')
const canItems = requireAnyPermission('can_manage_orders', 'can_manage_kitchen')

export const orderInclude = {
  checks: { orderBy: { number: 'asc' as const }, include: { zatcaDocuments: { select: { type: true, invoiceNo: true, qr: true, status: true, issuedAt: true } } } },
  table: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true, code: true } },
  shift: { select: { id: true, name: true } },
  rider: { select: { id: true, name: true, phone: true } },
  customer: { select: { id: true, name: true, phone: true, tags: true } },
  // the station routes each line to its kitchen slip / screen
  items: { orderBy: { createdAt: 'asc' as const }, include: { station: { select: { id: true, name: true, printerName: true } } } },
  // ZATCA (KSA) e-invoice / credit note with the QR the receipt prints
  zatcaDocuments: { where: { checkId: null }, select: { type: true, invoiceNo: true, qr: true, status: true, issuedAt: true }, orderBy: { icv: 'asc' as const } },
}

// Tells every open order / kitchen / guest screen about the change
export function publishOrder(
  order: { id: string; organizationId: string; branchId: string; tableId: string | null; orderNo: number; table?: { name: string } | null },
  action: string,
) {
  publish({
    topic: 'order', action, organizationId: order.organizationId, branchId: order.branchId,
    tableId: order.tableId, orderId: order.id, orderNo: order.orderNo, tableName: order.table?.name ?? null,
  })
}

async function findOrder(req: Request, id = req.params.id) {
  const order = await prisma.customerOrder.findFirst({
    where: { id, organizationId: req.user.organizationId },
    include: orderInclude,
  })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  return order
}

function dateRange(fromDate?: string, toDate?: string) {
  if (!fromDate && !toDate) return undefined
  return {
    ...(fromDate && { gte: new Date(`${fromDate}T00:00:00`) }),
    ...(toDate && { lte: new Date(`${toDate}T23:59:59.999`) }),
  }
}

// GET /orders
router.get('/', canOrders, async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, status, tableId, fromDate, toDate, search, orderType, source } = req.query as Record<string, string>
  const branch = await branchFilter(req, branchId)

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branch) where.branchId = branch
  if (status) where.status = status
  if (tableId) where.tableId = tableId
  if (orderType === 'dine_in' || orderType === 'takeaway' || orderType === 'delivery') where.orderType = orderType
  if (['qr', 'pos', 'online', 'call_center'].includes(source)) where.source = source
  const created = dateRange(fromDate, toDate)
  if (created) where.createdAt = created
  if (search && /^\d+$/.test(search.trim())) where.orderNo = Number(search.trim())

  const [orders, total] = await Promise.all([
    prisma.customerOrder.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { createdAt: 'desc' },
      include: {
        table: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
        shift: { select: { id: true, name: true } },
        _count: { select: { items: true, reviews: true } },
      },
    }),
    prisma.customerOrder.count({ where }),
  ])
  res.json(paginatedResponse(orders, total, page, limit))
})

// GET /orders/stats
router.get('/stats', canOrders, async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate } = req.query as Record<string, string>
  const branch = await branchFilter(req, branchId)
  const base: Record<string, unknown> = { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }
  const created = dateRange(fromDate, toDate)

  const [open, openPaid, completed, cancelled, awaitingAcceptance] = await Promise.all([
    prisma.customerOrder.aggregate({ where: { ...base, status: 'open' }, _count: { _all: true }, _sum: { totalAmount: true } }),
    // separate checks already paid on still-open split bills are collected money
    prisma.orderCheck.aggregate({ where: { status: 'paid', order: { ...base, status: 'open' } }, _sum: { totalAmount: true } }),
    prisma.customerOrder.aggregate({ where: { ...base, status: 'completed', ...(created && { createdAt: created }) }, _count: { _all: true }, _sum: { totalAmount: true } }),
    prisma.customerOrder.count({ where: { ...base, status: 'cancelled', ...(created && { createdAt: created }) } }),
    prisma.customerOrder.count({ where: awaitingWhere(req.user.organizationId, branch) }),
  ])
  res.json({
    openCount: open._count._all,
    openValue: round2((open._sum.totalAmount ?? 0) - (openPaid._sum.totalAmount ?? 0)),
    completedCount: completed._count._all,
    completedValue: completed._sum.totalAmount ?? 0,
    cancelledCount: cancelled,
    awaitingAcceptanceCount: awaitingAcceptance,
  })
})

// Orders with something for staff to accept: online orders waiting as a
// whole, and table orders with dishes guests sent from the table QR
const awaitingWhere = (organizationId: string, branch?: Awaited<ReturnType<typeof branchFilter>>) => ({
  organizationId,
  ...(branch && { branchId: branch }),
  OR: [
    { source: 'online', status: 'pending' },
    // kiosk orders paid at the counter, and those still waiting for the card
    { source: 'kiosk', status: 'pending' },
    { status: 'open', items: { some: { status: AWAITING } } },
  ],
})

// GET /orders/online/pending — everything waiting to be accepted, with items
// so it can be reviewed without opening each order; oldest request first
router.get('/online/pending', canOrders, async (req: Request, res: Response) => {
  const branch = await branchFilter(req, (req.query as Record<string, string>).branchId)
  const orders = await prisma.customerOrder.findMany({
    where: awaitingWhere(req.user.organizationId, branch),
    include: orderInclude,
  })
  const waitingSince = (o: (typeof orders)[number]) =>
    o.status === 'pending' ? o.createdAt.getTime() : Math.min(...o.items.filter((i) => i.status === AWAITING).map((i) => i.createdAt.getTime()))
  orders.sort((a, b) => waitingSince(a) - waitingSince(b))
  res.json({ data: orders, serverTime: new Date().toISOString() })
})

// GET /orders/:id
router.get('/:id', canItems, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  const reviews = await prisma.orderReview.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, rating: true, comment: true, guestName: true, createdAt: true },
  })
  res.json({ ...order, reviews, reviewCode: makeReviewCode(order.id) })
})

// Called as a receipt is printed: who took and who closed the order, the
// seller's VAT number, and which copy this is (paid receipts only; reprints
// are audit-logged)
router.post('/:id/receipt', canItems, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  let copy = 0
  if (order.status === 'completed' && !order.checks.length) {
    copy = (await prisma.customerOrder.update({ where: { id: order.id }, data: { receiptPrints: { increment: 1 } }, select: { receiptPrints: true } })).receiptPrints
    if (copy > 1) await logAudit(prisma, { req, action: 'reprint_receipt', module: 'orders', resourceType: 'order', resourceId: order.id, newData: { orderNo: order.orderNo, copy } })
  }
  const ids = [order.createdBy, order.closedBy].filter((x): x is string => !!x)
  const [users, org] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids }, organizationId: req.user.organizationId }, select: { id: true, firstName: true, lastName: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { vatNumber: true } }),
  ])
  const name = (id: string | null) => { const u = users.find((x) => x.id === id); return u ? `${u.firstName} ${u.lastName}`.trim() : null }
  res.json({ copy, createdBy: name(order.createdBy), closedBy: name(order.closedBy), vatNumber: org.vatNumber })
})

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

// Serializes changes to one order: dine-in orders lock their table (shared
// with the guest QR path, so a guest adding items and the cashier closing
// the bill can't interleave); takeaway orders lock the order row itself.
export async function lockOrder(tx: Tx, order: { id: string; tableId: string | null }) {
  if (order.tableId) await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${order.tableId} FOR UPDATE`
  const rows = await tx.$queryRaw<{ tableId: string | null }[]>`SELECT "tableId" FROM "CustomerOrder" WHERE id = ${order.id} FOR UPDATE`
  if (rows[0] && rows[0].tableId !== order.tableId) throw new AppError('This order moved to another table; refresh and try again', 409, 'ORDER_MOVED')
}

export async function assertBillEditable(tx: Tx, orderId: string) {
  if (await tx.orderCheck.count({ where: { orderId } })) throw new AppError('This bill has separate checks. Refund paid checks or reset an unpaid split before changing its dishes or totals', 409, 'CHECKS_LOCKED')
}

const round2 = (n: number) => regionalRoundMoney(n)

const NOT_ACCEPTED = 'Accept this online order first'

// Accept / reject act on a whole online order, or on the dishes a table sent
// from its QR (all of them, or the itemIds the staff member was looking at —
// a round the guest sent a moment later is left for its own decision).
const itemIdsSchema = z.array(z.string().min(1)).max(200).optional()

// POST /orders/:id/accept — accept the order or table dishes for payment.
// Full payment then confirms kitchen preparation. An online customer sees the optional ready-time estimate.
router.post('/:id/accept', canOrders, async (req: Request, res: Response) => {
  const { estimatedMinutes, itemIds } = z.object({
    estimatedMinutes: z.coerce.number().int().min(5).max(180).optional().nullable(),
    itemIds: itemIdsSchema,
  }).parse(req.body ?? {})
  const order = await findOrder(req)

  let acceptedItemIds: string[] = []
  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
    if (fresh.status === 'pending') {
      if (!fresh.items.some((i) => i.status !== 'cancelled')) throw new AppError('This order has no items left — reject it instead', 400, 'EMPTY_ORDER')
      const now = new Date()
      await tx.customerOrder.update({
        where: { id: order.id },
        data: {
          ...(fresh.orderType === 'delivery' && { deliveryPaymentMode: 'prepaid' }),
          status: 'open', acceptedBy: req.user.id, acceptedAt: now,
          estimatedReadyAt: estimatedMinutes ? new Date(now.getTime() + estimatedMinutes * 60_000) : null,
        },
      })
      acceptedItemIds = fresh.items.filter((i) => i.status !== 'cancelled').map((i) => i.id)
    } else {
      const waiting = fresh.status === 'open' ? fresh.items.filter((i) => i.status === AWAITING && (!itemIds || itemIds.includes(i.id))) : []
      if (!waiting.length) {
        throw new AppError(fresh.status === 'cancelled' && fresh.rejectedAt ? 'This order was already rejected' : 'Nothing on this order is waiting to be accepted', 409, 'INVALID_STATUS')
      }
      acceptedItemIds = waiting.map((i) => i.id)
      await tx.customerOrderItem.updateMany({ where: { id: { in: acceptedItemIds } }, data: { status: 'pending' } })
    }
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  await logAudit(prisma, { req, action: 'accept', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { estimatedMinutes, itemIds: acceptedItemIds } })
  publishOrder(order, order.status === 'pending' ? 'online_accepted' : 'items_accepted')
  // These accepted lines become eligible for payment; kitchen printing waits.
  res.json({ ...updated, acceptedItemIds })
})

// POST /orders/:id/reject — turn down an online order, or dishes a table sent
// from its QR. The reason is shown to the customer / guest. A table order
// left with nothing on it is closed so the table is free again.
router.post('/:id/reject', canOrders, async (req: Request, res: Response) => {
  const { reason, itemIds } = z.object({
    reason: z.string().trim().min(1, 'Choose or enter a reason').max(300),
    itemIds: itemIdsSchema,
  }).parse(req.body ?? {})
  const order = await findOrder(req)

  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
    const now = new Date()
    const close = { status: 'cancelled', cancelReason: reason, closedBy: req.user.id, closedAt: now, rejectedAt: now }
    if (fresh.status === 'pending') {
      await tx.customerOrderItem.updateMany({ where: { orderId: order.id }, data: { status: 'cancelled' } })
      await tx.customerOrder.update({ where: { id: order.id }, data: close })
    } else {
      const waiting = fresh.status === 'open' ? fresh.items.filter((i) => i.status === AWAITING && (!itemIds || itemIds.includes(i.id))) : []
      if (!waiting.length) {
        throw new AppError(fresh.status === 'cancelled' && fresh.rejectedAt ? 'This order was already rejected' : 'Nothing on this order is waiting — cancel it instead', 409, 'INVALID_STATUS')
      }
      const ids = waiting.map((i) => i.id)
      await tx.customerOrderItem.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled', rejectReason: reason } })
      if (!fresh.items.some((i) => !ids.includes(i.id) && i.status !== 'cancelled')) {
        await tx.customerOrder.update({ where: { id: order.id }, data: { ...close, billRequestedAt: null } })
      }
    }
    await recalcOrderTotals(tx, order.id)
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  await logAudit(prisma, { req, action: 'reject', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { reason, itemIds } })
  publishOrder(order, order.status === 'pending' ? 'online_rejected' : 'items_rejected')
  res.json(updated)
})

// POST /orders/:id/complete — take payment and close the order. Payment can
// be taken while dishes are still cooking (takeaway pays first); the kitchen
// keeps working on them. The order is counted in today's Daily Sales.
// gift_card / loyalty / house_account: stored value and customer credit (services/tenders)
const PAYMENT_METHODS = ['cash', 'card', 'mada', 'bank_transfer', 'other', 'gift_card', 'loyalty', 'house_account'] as const

export const completeOrderSchema = z.object({
    counterCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,30}$/).optional(),
    approvalToken: z.string().optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
    // split bill: e.g. part cash, part card. Omitted = the whole bill by paymentMethod.
    payments: z.array(z.object({
      method: z.enum(PAYMENT_METHODS),
      amount: z.coerce.number().positive('Each payment must be more than zero').refine(validMoneyPrecision, 'Invalid currency precision'),
      giftCardCode: z.string().trim().min(4).max(40).optional(),
    })).min(1).max(6).optional(),
    giftCardCode: z.string().trim().min(4).max(40).optional(),
    // attach a known customer at the till (loyalty, house account, history)
    customerId: z.string().min(1).optional(),
    discountAmount: z.coerce.number().min(0, 'Discount cannot be negative').default(0),
    discountReason: z.string().trim().max(200).optional().nullable(),
    amountTendered: z.coerce.number().min(0).optional().nullable(),
    notes: z.string().trim().max(500).optional(),
})

export async function completeOrderInTransaction(tx: Tx, req: Request, order: { id: string; organizationId: string; branchId: string; tableId: string | null }, body: z.infer<typeof completeOrderSchema>, paidAt?: Date, capturedTillId?: string | null, riderCustody = false) {
  if (body.discountAmount > 0 && (body.discountReason ?? '').length < 3) throw new AppError('Enter a reason for the discount', 400, 'VALIDATION_ERROR')
  const [{ permissions }, org] = await Promise.all([
    getUserPermissions(tx, req.user.id),
    tx.organization.findUniqueOrThrow({ where: { id: order.organizationId }, select: { maxStaffDiscountPct: true } }),
  ])
  let approvedBy: string | undefined

  await lockOrder(tx, order)
  const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
  if (fresh.status === 'pending') throw new AppError(NOT_ACCEPTED, 400, 'NOT_ACCEPTED')
  if (fresh.status !== 'open') throw new AppError('Only open orders can be completed', 400, 'INVALID_STATUS')
  await assertBillEditable(tx, order.id)
  await assertCounter(tx, order, body.counterCode ?? fresh.counterCode)
  if (riderCustody && (fresh.orderType !== 'delivery' || fresh.deliveryPaymentMode !== 'cod' || fresh.deliveryStatus !== 'picked_up' || !fresh.riderId)) throw new AppError('Only a dispatched COD order can record rider cash', 409, 'INVALID_DELIVERY_STATUS')
  if (fresh.items.some((i) => i.status === AWAITING)) throw new AppError('Accept or reject the dishes this table is waiting on first', 400, 'NOT_ACCEPTED')
  if (!fresh.items.some((i) => i.status !== 'cancelled')) throw new AppError('This order has no items to charge', 400, 'EMPTY_ORDER')

  await tx.customerOrder.update({ where: { id: order.id }, data: { discountAmount: body.discountAmount, discountReason: body.discountAmount > 0 ? body.discountReason : null } })
  const totals = await recalcOrderTotals(tx, order.id)
  if (body.discountAmount > totals.itemsTotal) throw new AppError('Discount cannot be more than the order total', 400, 'VALIDATION_ERROR')
  // promotions do not count toward the staff limit; combining is a Settings rule
  await assertPromotionCombination(tx, order.organizationId, body.discountAmount, totals.promotionAmount)
  const discountPct = totals.itemsTotal > 0 ? (body.discountAmount / totals.itemsTotal) * 100 : 0
  if (discountPct > org.maxStaffDiscountPct + 0.001 && !permissions.has('can_apply_discount')) {
    if (!body.approvalToken) throw new AppError(`Discounts above ${org.maxStaffDiscountPct}% need a manager`, 403, 'DISCOUNT_LIMIT')
    approvedBy = await authorizePos(tx, req, 'discount', order.branchId, order.id, body.approvalToken)
  }

  if (body.customerId && body.customerId !== fresh.customerId) {
    if (!await tx.customer.count({ where: { id: body.customerId, organizationId: order.organizationId } })) throw new AppError('Customer not found', 404, 'NOT_FOUND')
    await tx.customerOrder.update({ where: { id: order.id }, data: { customerId: body.customerId } })
  }
  const customerId = body.customerId ?? fresh.customerId

  // what was paid, by method — always adds up to the bill
  const tenders = body.payments
    ? body.payments.map((p) => ({ method: p.method, amount: round2(p.amount), giftCardCode: p.giftCardCode }))
    : [{ method: body.paymentMethod, amount: totals.totalAmount, giftCardCode: body.giftCardCode }]
  const payments = tenders.map(({ method, amount }) => ({ method, amount }))
  const paid = round2(payments.reduce((n, p) => n + p.amount, 0))
  if (Math.abs(paid - totals.totalAmount) > moneyTolerance()) {
    throw new AppError(`Payments add up to ${paid} but the bill is ${totals.totalAmount}`, 400, 'PAYMENT_MISMATCH')
  }
  const methods = [...new Set(payments.map((p) => p.method))]
  const paymentMethod = methods.length === 1 ? methods[0] : 'split'
  const cashDue = round2(payments.filter((p) => p.method === 'cash').reduce((n, p) => n + p.amount, 0))

  let changeAmount: number | null = null
  if (cashDue > 0 && body.amountTendered != null) {
    if (body.amountTendered < cashDue) throw new AppError('Cash received is less than the amount due', 400, 'VALIDATION_ERROR')
    changeAmount = round2(body.amountTendered - cashDue)
  }

  // gift card / points / house account balances move in this same transaction
  await debitTenders(tx, req, { id: order.id, organizationId: order.organizationId, customerId }, tenders)
  const tillSessionId = await recordPayment(tx, req, order, payments, 'sale', order.id, { occurredAt: paidAt, sessionId: capturedTillId, riderCustody })

  // Payment confirms preparation; it never marks dishes served or handed over.
  const fullyPaidAt = paidAt ?? new Date()
  await tx.customerOrder.update({
    where: { id: order.id },
    data: {
      status: 'completed',
      ...(!riderCustody && fresh.deliveryPaymentMode === 'cod' && { deliveryPaymentMode: 'prepaid' }),
      tillSessionId,
      counterCode: body.counterCode ?? fresh.counterCode,
      paymentMethod,
      payments,
      amountTendered: cashDue > 0 ? body.amountTendered ?? null : null,
      changeAmount,
      notes: body.notes || fresh.notes,
      closedBy: req.user.id,
      closedAt: fullyPaidAt,
      estimatedReadyAt: estimatedReadyAfterPayment(fresh, fullyPaidAt),
    },
  })
  // recipe cost of what was sold (and, in "recipes" mode, the stock it used)
  await costAndConsumeOrder(tx, order.id, req.user.id)
  await addOrderToDailySale(tx, order.id, req.user.id)
  if (fresh.tableId) await tx.diningTable.update({ where: { id: fresh.tableId }, data: { needsClearing: true } })
  const closed = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
  await recordVisit(tx, closed)
  await earnLoyalty(tx, req, closed, payments)
  const updated = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  return { updated, approvedBy }
}

router.post('/:id/complete', canOrders, async (req: Request, res: Response) => {
  const body = completeOrderSchema.parse(req.body ?? {})
  if (body.discountAmount > 0 && (body.discountReason ?? '').length < 3) {
    throw new AppError('Enter a reason for the discount', 400, 'VALIDATION_ERROR')
  }
  const order = await findOrder(req)
  const { updated, approvedBy } = await prisma.$transaction((tx) => completeOrderInTransaction(tx, req, order, body))
  await logAudit(prisma, { req, action: 'complete', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { paymentMethod: body.paymentMethod, payments: body.payments, discountAmount: body.discountAmount, discountReason: body.discountReason, approvedBy } })
  await cancelOpenIntents(order.id, 'Paid at the till')
  publishOrder(order, 'completed')
  publish({ topic: 'sale', action: 'updated', organizationId: order.organizationId, branchId: order.branchId })
  // KSA: signed simplified tax invoice for the receipt (never blocks the payment)
  const zatca = await issueForOrder(order.id, 'invoice').catch((err) => { console.error('[zatca] invoice not issued', order.id, err); return null })
  const zatcaDocuments = zatca ? [{ type: zatca.type, invoiceNo: zatca.invoiceNo, qr: zatca.qr, status: zatca.status, issuedAt: zatca.issuedAt }] : updated.zatcaDocuments
  res.json({ ...updated, zatcaDocuments, reviewCode: makeReviewCode(updated.id) })
})

// POST /orders/:id/cancel — an open (unpaid) order
router.post('/:id/cancel', canOrders, async (req: Request, res: Response) => {
  const body = z.object({ reason: z.string().trim().max(500).optional(), voidReasonId: z.string().optional(), approvalToken: z.string().optional() }).parse(req.body ?? {})
  let reason = body.reason ?? ''
  let approvedBy: string | undefined
  const order = await findOrder(req)

  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (fresh.status === 'pending') throw new AppError('Reject this online order instead', 400, 'NOT_ACCEPTED')
    if (fresh.status !== 'open') throw new AppError('Only open orders can be cancelled — use Refund for a paid order', 400, 'INVALID_STATUS')
    await assertBillEditable(tx, order.id)
    if (fresh.deliveryStatus === 'picked_up') throw new AppError('Record a failed delivery before cancelling a dispatched order', 409, 'DELIVERY_LOCKED')
    reason = await resolveVoidReason(tx, req.user.organizationId, body)
    approvedBy = await authorizePos(tx, req, 'void', order.branchId, order.id, body.approvalToken)
    const cooked = await tx.customerOrderItem.findMany({ where: { orderId: order.id, status: { in: ['preparing', 'ready', 'served'] } }, select: { id: true } })
    await tx.customerOrderItem.updateMany({ where: { orderId: order.id, status: { not: 'cancelled' } }, data: { status: 'cancelled', cancelReason: reason, cancelledBy: req.user.id } })
    for (const c of cooked) {
      await tx.customerOrderItem.update({ where: { id: c.id }, data: { wastedAt: new Date() } })
      await writeOffCancelledItem(tx, c.id, req.user.id)
    }
    await tx.customerOrder.update({
      where: { id: order.id },
      data: { status: 'cancelled', cancelReason: reason, closedBy: req.user.id, closedAt: new Date() },
    })
    await recalcOrderTotals(tx, order.id)
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  await logAudit(prisma, { req, action: 'cancel', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { reason, approvedBy } })
  await cancelOpenIntents(order.id, 'The order was cancelled')
  publishOrder(order, 'cancelled')
  res.json(updated)
})

// POST /orders/:id/refund — a paid order, while its day is not yet finalized
// in Daily Sales: it is taken back out of the day's sales.
router.post('/:id/refund', canOrders, async (req: Request, res: Response) => {
  const body = z.object({ reason: z.string().trim().min(3).max(500), approvalToken: z.string().optional() }).parse(req.body ?? {})
  const reason = body.reason
  let approvedBy: string | undefined
  const order = await findOrder(req)
  if (order.checks.length) {
    const { refundChecks } = await import('../services/orderChecks')
    await prisma.$transaction((tx) => refundChecks(tx, req, order.id, reason, body.approvalToken))
    await issueForOrder(order.id, 'credit', reason).catch((err) => console.error('[zatca] split credit not issued', order.id, err))
    await refundIntentsForOrder(order.id).catch((err) => console.error('[payments] refund not sent', order.id, err))
    publishOrder(order, 'refunded')
    publish({ topic: 'sale', action: 'updated', organizationId: order.organizationId, branchId: order.branchId })
    res.json(await findOrder(req)); return
  }

  const updated = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (fresh.status !== 'completed') throw new AppError('Only paid orders can be refunded', 400, 'INVALID_STATUS')
    if (fresh.deliveryStatus === 'picked_up') throw new AppError('Record the failed delivery before refunding an order on the road', 409, 'DELIVERY_LOCKED')
    if (await tx.riderCashCollection.count({ where: { orderId: order.id, settlementId: null } })) throw new AppError('Settle the rider’s cash into a till before refunding this order', 409, 'RIDER_CASH_OUTSTANDING')
    approvedBy = await authorizePos(tx, req, 'refund', order.branchId, order.id, body.approvalToken)
    await recordPayment(tx, req, fresh, orderPayments(fresh), 'refund')
    // gift card / points / house account money goes back; earned points too
    await creditTenders(tx, req, fresh.organizationId, order.id)
    await reverseLoyaltyEarn(tx, req, fresh.organizationId, order.id)
    await reverseVisit(tx, fresh)
    await removeOrderFromDailySale(tx, order.id)
    await restoreOrderStock(tx, order.id, req.user.id)
    await tx.customerOrderItem.updateMany({ where: { orderId: order.id, status: { in: ['pending', 'preparing', 'ready'] } }, data: { status: 'cancelled' } })
    return tx.customerOrder.update({
      where: { id: order.id },
      data: { status: 'refunded', cancelReason: reason },
      include: orderInclude,
    })
  })
  await logAudit(prisma, { req, action: 'refund', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { reason, approvedBy, amount: order.totalAmount } })
  publishOrder(order, 'refunded')
  publish({ topic: 'sale', action: 'updated', organizationId: order.organizationId, branchId: order.branchId })
  // KSA: a refund is a credit note referencing the original e-invoice
  await issueForOrder(order.id, 'credit', reason).catch((err) => console.error('[zatca] credit note not issued', order.id, err))
  // money taken online / on the terminal goes back through the integration
  await refundIntentsForOrder(order.id).catch((err) => console.error('[payments] refund not sent', order.id, err))
  res.json(await prisma.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude }))
})

// POST /orders/:id/fire — send held courses to the kitchen (one course, or
// every held course). Returns the fired line ids so the screen prints their
// station slips.
router.post('/:id/fire', canItems, async (req: Request, res: Response) => {
  const { course } = z.object({ course: z.number().int().min(1).max(5).optional() }).parse(req.body ?? {})
  const order = await findOrder(req)
  const fired = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
    if (fresh.status !== 'open' && fresh.status !== 'completed') throw new AppError('This order is closed', 400, 'INVALID_STATUS')
    if (fresh.status !== 'completed') throw new AppError('Full payment is required before firing kitchen courses', 409, 'PAYMENT_REQUIRED')
    const held = fresh.items.filter((i) => i.held && i.status !== 'cancelled' && (course === undefined || i.course === course))
    if (held.length === 0) throw new AppError(course ? `Nothing is held in course ${course}` : 'Nothing is on hold', 409, 'NOTHING_HELD')
    await tx.customerOrderItem.updateMany({ where: { id: { in: held.map((i) => i.id) } }, data: { held: false, firedAt: new Date() } })
    return held.map((i) => i.id)
  })
  await logAudit(prisma, { req, action: 'fire_course', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { course: course ?? 'all', items: fired.length } })
  publishOrder(order, 'items_fired')
  res.json({ ...(await prisma.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })), firedItemIds: fired })
})

// PATCH /orders/:id/items/:itemId — kitchen/floor status changes, incl. cancelling one line
router.patch('/:id/items/:itemId', canItems, async (req: Request, res: Response) => {
  const body = z.object({ status: z.enum(ITEM_STATUSES), reason: z.string().trim().max(200).optional().nullable(), voidReasonId: z.string().optional(), approvalToken: z.string().optional() }).parse(req.body)
  const { status } = body
  const reason = status === 'cancelled' ? await resolveVoidReason(prisma, req.user.organizationId, body) : body.reason
  let approvedBy: string | undefined
  const order = await findOrder(req)
  let wasted = false
  let dishName = ''
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
    if (fresh.status === 'pending') throw new AppError(NOT_ACCEPTED, 400, 'NOT_ACCEPTED')
    if (fresh.status !== 'open' && fresh.status !== 'completed') throw new AppError('This order is closed', 400, 'INVALID_STATUS')
    const item = fresh.items.find((i) => i.id === req.params.itemId)
    if (!item) throw new AppError('Order item not found', 404, 'NOT_FOUND')
    if (item.status === 'cancelled') throw new AppError('This item was cancelled', 400, 'INVALID_STATUS')
    if (item.status === AWAITING && status !== 'cancelled') throw new AppError('Accept this dish first', 400, 'NOT_ACCEPTED')
    if (item.held && status !== 'cancelled') throw new AppError(`Course ${item.course} is on hold — fire it first`, 400, 'COURSE_HELD')
    if (status === 'cancelled' && fresh.status !== 'open') throw new AppError('This order is already paid — refund it instead of removing dishes', 400, 'INVALID_STATUS')
    if (status === 'cancelled') await assertBillEditable(tx, order.id)
    if (status === 'cancelled' && ['picked_up', 'delivered'].includes(fresh.deliveryStatus ?? '')) throw new AppError('A dispatched delivery cannot have its bill changed', 409, 'DELIVERY_LOCKED')
    if (status !== 'cancelled') {
      if (fresh.status !== 'completed') throw new AppError('Full payment is required before kitchen preparation', 409, 'PAYMENT_REQUIRED')
      await tx.customerOrderItem.update({ where: { id: item.id }, data: { status } })
      return
    }
    approvedBy = await authorizePos(tx, req, 'void', order.branchId, order.id, body.approvalToken)
    dishName = item.dishName
    // the kitchen had already started on it: the food is lost, not unsold
    wasted = ['preparing', 'ready', 'served'].includes(item.status)
    await tx.customerOrderItem.update({
      where: { id: item.id },
      data: { status, cancelReason: reason, cancelledBy: req.user.id, ...(wasted && { wastedAt: new Date() }) },
    })
    if (wasted) await writeOffCancelledItem(tx, item.id, req.user.id)
    await recalcOrderTotals(tx, order.id)
  })
  if (status === 'cancelled') {
    await logAudit(prisma, { req, action: 'cancel_item', module: 'orders', resourceType: 'customer_order', resourceId: order.id, resourceRef: String(order.orderNo), branchId: order.branchId, newData: { itemId: req.params.itemId, dishName, reason, wasted, approvedBy } })
  }
  publishOrder(order, 'item_status')
  res.json(await findOrder(req))
})

export default router
