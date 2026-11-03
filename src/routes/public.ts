import { roundMoney } from '../utils/money'
import { publicRegion } from '../utils/regions'
import { runWithCurrency } from '../utils/money'
import { Router, Request, Response } from 'express'
import { assertReadyForPayment } from '../services/orderPaymentPolicy'
import { assertBillEditable } from './orders'
import { z } from 'zod'
import { lineSelectionSchema, loadDishOptions, priceSelection, menuOptionsPayload, resolveStations } from '../services/menuOptions'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { imageUpload, resolveUpload, removeUpload } from '../middleware/imageUpload'
import { rateLimit } from '../middleware/rateLimit'
import { ensureShifts, currentShift, nextShift, nextOrderNo, recalcOrderTotals } from '../utils/menu'
import { dishImageUrl } from './menu'
import { brandingLogoUrl } from './orgs'
import { publish, openStream } from '../utils/liveEvents'
import { parseReviewCode } from '../utils/reviewCode'
import { branchUnavailable } from '../services/branchMenu'

// Unauthenticated endpoints behind the table QR codes. A table is identified
// only by its unguessable token; nothing here takes an organization, branch
// or table id from the client.
const router = Router()

const REVIEW_WINDOW_DAYS = 7
const MAX_REVIEWS_PER_ORDER = 10

async function tableByOrderToken(token: string) {
  const table = await prisma.diningTable.findUnique({
    where: { orderToken: token },
    include: { branch: true, organization: true },
  })
  if (!table || !table.isActive || !table.branch.isActive || !table.organization.isActive) {
    throw new AppError('This table QR code is not active. Please ask the staff for help.', 404, 'TABLE_NOT_FOUND')
  }
  return table
}

// A branch can switch table QR ordering off. Guests then can't add dishes;
// an order already on the table can still be followed, cancelled and billed.
function assertTableOrdering(branch: { tableOrderingEnabled: boolean }) {
  if (!branch.tableOrderingEnabled) {
    throw new AppError('Ordering from the table QR is switched off right now. Please ask our staff to take your order.', 403, 'TABLE_ORDERING_DISABLED')
  }
}

router.use('/tables/:token', rateLimit('table-region', 180, 60_000), async (req, _res, next) => {
  const table = await tableByOrderToken(req.params.token)
  runWithCurrency(table.organization.currency, () => next())
})

async function tableByReviewToken(token: string) {
  const table = await prisma.diningTable.findUnique({
    where: { reviewToken: token },
    include: { branch: true, organization: true },
  })
  if (!table || !table.branch.isActive || !table.organization.isActive) {
    throw new AppError('This review QR code is not active.', 404, 'TABLE_NOT_FOUND')
  }
  return table
}

// Guests see the merged order — all items from everyone at the table —
// without staff-only fields.
// "Served" = everything still on the order has reached the table.
// Reviews open after service; payment opens after staff acceptance.
export function isServed(order: { status: string; items: { status: string }[] }) {
  if (order.status === 'cancelled' || order.status === 'refunded') return false
  const live = order.items.filter((i) => i.status !== 'cancelled')
  return live.length > 0 && live.every((i) => i.status === 'served')
}

// What a table's guests see: live dishes, plus the ones staff turned down
// (with the reason) — not dishes removed later at the counter
export const guestItems = {
  items: { where: { OR: [{ status: { not: 'cancelled' } }, { rejectReason: { not: null } }] }, orderBy: { createdAt: 'asc' as const } },
}

export function publicOrder(order: Prisma.CustomerOrderGetPayload<{ include: { items: true } }> | null) {
  if (!order) return null
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    orderType: order.orderType,
    deliveryFee: order.deliveryFee,
    deliveryZoneName: order.deliveryZoneName,
    deliveryStatus: order.deliveryStatus,
    dispatchedAt: order.dispatchedAt,
    deliveredAt: order.deliveredAt,
    acceptedAt: order.acceptedAt,
    estimatedReadyAt: order.estimatedReadyAt,
    // why an online order was turned down (reasons are written for the
    // customer); any other cancellation reason stays internal
    rejectReason: order.rejectedAt ? order.cancelReason : null,
    served: isServed(order),
    paid: order.status === 'completed',
    paymentMethod: order.status === 'completed' ? order.paymentMethod : null,
    closedAt: order.closedAt,
    billRequestedAt: order.billRequestedAt,
    itemsTotal: order.itemsTotal,
    discountAmount: order.discountAmount,
    // promotion names and amounts only (no rule details)
    promotionAmount: order.promotionAmount,
    promotions: ((order.promotions as { name: string; amount: number }[] | null) ?? []).map((p) => ({ name: p.name, amount: p.amount })),
    subtotal: order.subtotal,
    vatRate: order.vatRate,
    vatAmount: order.vatAmount,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    items: order.items.map((i) => ({
      id: i.id,
      dishName: i.dishName,
      selection: i.selection ? (() => {
        const sel = i.selection as unknown as import('../services/menuOptions').Selection
        return { ...sel, modifiers: sel.modifiers?.map(({ itemId: _id, itemQuantity: _q, ...m }) => m) }
      })() : null,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
      notes: i.notes,
      guestName: i.guestName,
      status: i.status,
      rejectReason: i.rejectReason,
      createdAt: i.createdAt,
    })),
  }
}

// The login page and the QR pages need the brand before anyone signs in.
// This deployment serves one organization, so the first active one is it.
const brandOrg = () => prisma.organization.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } })

// GET /public/branding
router.get('/branding', async (_req: Request, res: Response) => {
  const org = await brandOrg()
  res.json({
    name: org ? org.tradeName || org.name : 'FoodSync',
    logoUrl: org ? brandingLogoUrl(org) : null,
    ...publicRegion(org),
  })
})

// GET /public/branding/logo
router.get('/branding/logo', async (_req: Request, res: Response) => {
  const org = await brandOrg()
  const file = resolveUpload(org?.logoPath)
  if (!file) throw new AppError('No logo uploaded', 404, 'NOT_FOUND')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.sendFile(file)
})

// GET /public/tables/:token/menu — the dishes of the shift running right now
router.get('/tables/:token/menu', rateLimit('menu', 120, 60_000), async (req: Request, res: Response) => {
  const table = await tableByOrderToken(req.params.token)
  const org = table.organization
  const shifts = await ensureShifts(prisma, org.id)
  const shift = currentShift(shifts, org.timezone)

  const categories = shift ? await guestMenuCategories(org.id, table.branchId, shift.id) : []

  const upcoming = shift ? null : nextShift(shifts, org.timezone)
  res.json({
    restaurant: { name: org.tradeName || org.name, ...publicRegion(org), logoUrl: brandingLogoUrl(org) },
    // same table — lets the bill screen link straight to this table's review form
    reviewToken: table.reviewToken,
    branch: { name: table.organization.multiBranch ? table.branch.name : table.organization.tradeName || table.organization.name },
    table: { name: table.name },
    // false = the branch switched table service off (Settings → Table Service)
    tableOrdering: table.branch.tableOrderingEnabled,
    vat: { enabled: table.branch.vatEnabled, rate: table.branch.vatRate },
    shift: shift && { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime },
    nextShift: upcoming && { name: upcoming.name, startTime: upcoming.startTime, endTime: upcoming.endTime },
    categories,
  })
})

// GET /public/tables/:token/order — the table's running (merged) order
// GET /public/tables/:token/order?orderId= — the table's running order. After
// it has been paid, the phone that ordered (it remembers the order id) keeps
// seeing the paid bill for a few hours; other phones just see a free table.
const PAID_BILL_HOURS = 6
router.get('/tables/:token/order', rateLimit('order-view', 240, 60_000), async (req: Request, res: Response) => {
  const table = await tableByOrderToken(req.params.token)
  const include = guestItems
  let order = await prisma.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' }, include })
  const remembered = typeof req.query.orderId === 'string' ? req.query.orderId : null
  if (!order && remembered) {
    order = await prisma.customerOrder.findFirst({
      where: {
        id: remembered, tableId: table.id, status: 'completed',
        closedAt: { gte: new Date(Date.now() - PAID_BILL_HOURS * 3_600_000) },
      },
      include,
    })
  }
  res.json({ order: publicOrder(order) })
})

// POST /public/tables/:token/bill — "Request the bill": tells the staff
// screens this accepted table order is ready for payment before preparation.
router.post('/tables/:token/bill', rateLimit('bill-request', 6, 60_000), async (req: Request, res: Response) => {
  const table = await tableByOrderToken(req.params.token)
  const order = await prisma.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' }, include: { items: true } })
  if (!order) throw new AppError('There is no open order on this table.', 404, 'ORDER_NOT_FOUND')
  assertReadyForPayment(order)
  const updated = await prisma.customerOrder.update({
    where: { id: order.id },
    data: { billRequestedAt: new Date() },
    include: { items: { where: { status: { not: 'cancelled' } }, orderBy: { createdAt: 'asc' } } },
  })
  publish({
    topic: 'order', action: 'bill_requested', organizationId: table.organizationId, branchId: table.branchId,
    tableId: table.id, orderId: order.id, orderNo: order.orderNo, tableName: table.name,
  })
  res.json({ order: publicOrder(updated) })
})

// GET /public/tables/:token/stream — live updates for the guest screen of
// this table: its order changing, and menu / stock changes of its branch.
router.get('/tables/:token/stream', rateLimit('stream', 60, 60_000), async (req: Request, res: Response) => {
  const table = await tableByOrderToken(req.params.token)
  openStream(req, res, (e) => {
    if (e.organizationId !== table.organizationId) return null
    if (e.topic === 'order' && e.tableId === table.id) return { action: e.action }
    if (e.topic === 'menu') return { action: e.action }
    if (e.topic === 'availability' && e.branchId === table.branchId) return { action: e.action }
    if (e.topic === 'table' && e.tableId === table.id) return { action: e.action }
    return null
  })
})

// GET /public/ready/:token — customer-facing "order ready" screen of a branch:
// takeaway / delivery / online orders of the last 12 hours, Preparing while the
// kitchen works, Ready once every dish is ready, gone when handed over
router.get('/ready/:token', rateLimit('ready-display', 120, 60_000), async (req: Request, res: Response) => {
  const branch = await prisma.branch.findFirst({ where: { readyDisplayToken: req.params.token, isActive: true }, include: { organization: true } })
  if (!branch || !req.params.token) throw new AppError('This screen link is no longer valid', 404, 'NOT_FOUND')
  const orders = await prisma.customerOrder.findMany({
    where: { branchId: branch.id, orderType: { not: 'dine_in' }, status: 'completed', createdAt: { gte: new Date(Date.now() - 12 * 3600_000) } },
    select: { orderNo: true, customerName: true, updatedAt: true, items: { where: { status: { not: 'cancelled' }, held: false }, select: { status: true } } },
    orderBy: { orderNo: 'asc' },
  })
  const preparing: number[] = [], ready: { orderNo: number; name: string | null }[] = []
  for (const o of orders) {
    const s = o.items.map((i) => i.status)
    if (s.length === 0 || s.every((x) => x === 'served')) continue
    if (s.some((x) => x === 'pending' || x === 'preparing' || x === 'awaiting')) preparing.push(o.orderNo)
    else ready.push({ orderNo: o.orderNo, name: o.customerName ? o.customerName.split(' ')[0] : null })
  }
  const org = branch.organization
  res.setHeader('Cache-Control', 'no-store')
  res.json({ restaurant: org.tradeName || org.name, branch: org.multiBranch ? branch.name : null, logoUrl: brandingLogoUrl(org), preparing, ready, serverTime: new Date().toISOString() })
})

export const placeOrderSchema = z.object({
  guestName: z.string().trim().max(40).optional().nullable(),
  items: z.array(z.object({
    dishId: z.string().min(1),
    quantity: z.number().int().min(1).max(50),
    notes: z.string().trim().max(200).optional().nullable(),
    ...lineSelectionSchema, // size, modifiers, combo choices
  })).min(1, 'Your cart is empty').max(50),
})

// The dishes guests can order now at a branch (table QR and kiosk)
export async function guestMenuCategories(organizationId: string, branchId: string, shiftId: string) {
  const { menu, off: hidden } = await branchUnavailable(prisma, organizationId, branchId)
  const [dishes, outOfStock] = await Promise.all([
    prisma.dish.findMany({
      where: {
        organizationId,
        isActive: true,
        category: { isActive: true },
        shifts: { some: { shiftId } },
      },
      include: { category: true },
      orderBy: [{ category: { sortOrder: 'asc' } }, { category: { name: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.dishOutOfStock.findMany({ where: { branchId }, select: { dishId: true } }),
  ])
  for (const o of outOfStock) hidden.add(o.dishId)
  const options = await loadDishOptions(prisma, dishes.map((d) => d.id), branchId)
  const byCategory = new Map<string, { id: string; name: string; description: string | null; dishes: unknown[] }>()
  for (const d of dishes) {
    if (hidden.has(d.id)) continue
    let cat = byCategory.get(d.categoryId)
    if (!cat) {
      cat = { id: d.category.id, name: d.category.name, description: d.category.description, dishes: [] }
      byCategory.set(d.categoryId, cat)
    }
    cat.dishes.push({ id: d.id, name: d.name, description: d.description, price: menu.get(d.id)!.price, imageUrl: dishImageUrl(d), ...menuOptionsPayload(options.get(d.id), hidden) })
  }
  return [...byCategory.values()]
}

export class DishesUnavailable extends Error { constructor(message: string, public dishIds: string[]) { super(message) } }

// Price a guest cart on the server (table QR and kiosk): every dish must be
// active, in stock at the branch and on the current shift.
export async function priceGuestCart(organizationId: string, branchId: string, shiftId: string, items: z.infer<typeof placeOrderSchema>['items'], guestName: string | null, status: string) {
  const { menu, off: unavailable } = await branchUnavailable(prisma, organizationId, branchId)
  const dishIds = [...new Set(items.map((i) => i.dishId))]
  const [dishes, outOfStock] = await Promise.all([
    prisma.dish.findMany({
      where: { id: { in: dishIds }, organizationId },
      include: { category: { select: { isActive: true } }, shifts: { select: { shiftId: true } } },
    }),
    // Include combo components, which need not be top-level cart dishes.
    prisma.dishOutOfStock.findMany({ where: { branchId }, select: { dishId: true } }),
  ])
  for (const o of outOfStock) unavailable.add(o.dishId)
  const dishMap = new Map(dishes.map((d) => [d.id, d]))
  const rejectedIds = dishIds.filter((id) => {
    const d = dishMap.get(id)
    return !d || !d.isActive || !d.category.isActive || unavailable.has(id) || !d.shifts.some((s) => s.shiftId === shiftId)
  })
  if (rejectedIds.length > 0) {
    const names = rejectedIds.map((id) => dishMap.get(id)?.name ?? 'an item')
    throw new DishesUnavailable(`Sorry, ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not available right now. Please update your cart.`, rejectedIds)
  }
  const [options, stations] = await Promise.all([loadDishOptions(prisma, dishIds, branchId), resolveStations(prisma, organizationId, dishIds)])
  return items.map((i) => {
    const d = dishMap.get(i.dishId)!
    const { unitPrice, selection } = priceSelection({ ...d, price: menu.get(d.id)!.price }, options.get(d.id), i, unavailable)
    return {
      dishId: d.id,
      dishName: d.name,
      unitPrice,
      quantity: i.quantity,
      lineTotal: roundMoney(unitPrice * i.quantity),
      notes: i.notes || null,
      selection: (selection ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      stationId: stations.get(d.id) ?? null,
      guestName,
      status,
    }
  })
}

// POST /public/tables/:token/orders — add items to the table's open order,
// opening a new one when the table has none. Several guests can submit at
// the same moment: the table row is locked for the duration so they all land
// on one order instead of racing to create two.
router.post('/tables/:token/orders', rateLimit('order-place', 20, 60_000), async (req: Request, res: Response) => {
  const body = placeOrderSchema.parse(req.body)
  const table = await tableByOrderToken(req.params.token)
  assertTableOrdering(table.branch)
  const org = table.organization
  const shifts = await ensureShifts(prisma, org.id)
  const shift = currentShift(shifts, org.timezone)
  if (!shift) {
    const upcoming = nextShift(shifts, org.timezone)
    throw new AppError(
      upcoming ? `Ordering is closed right now. ${upcoming.name} starts at ${upcoming.startTime}.` : 'Ordering is closed right now.',
      400, 'NO_ACTIVE_SHIFT',
    )
  }

  let lines: Awaited<ReturnType<typeof priceGuestCart>>
  try {
    // Staff accept each round, then full payment releases kitchen preparation.
    lines = await priceGuestCart(org.id, table.branchId, shift.id, body.items, body.guestName || null, 'awaiting')
  } catch (e) {
    if (!(e instanceof DishesUnavailable)) throw e
    res.status(409).json({ message: e.message, code: 'DISH_UNAVAILABLE', unavailableDishIds: e.dishIds })
    return
  }

  // Retry when two brand-new orders (different tables) race for the same orderNo
  for (let attempt = 0; ; attempt++) {
    try {
      const order = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${table.id} FOR UPDATE`
        const seated = await tx.diningTable.findUniqueOrThrow({ where: { id: table.id } })
        if (seated.needsClearing || !seated.isActive) throw new AppError('Please ask staff to prepare this table for a new order', 409, 'TABLE_NEEDS_CLEARING')
        let open = await tx.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' } })
        if (open) await assertBillEditable(tx, open.id)
        if (!open) {
          open = await tx.customerOrder.create({
            data: {
              organizationId: org.id,
              branchId: table.branchId,
              tableId: table.id,
              guestCount: seated.guestCount,
              shiftId: shift.id,
              orderNo: await nextOrderNo(tx, org.id, table.branchId),
            },
          })
        }
        await tx.customerOrderItem.createMany({ data: lines.map((l) => ({ ...l, orderId: open!.id })) })
        // more food on the way — a pending bill request no longer applies
        if (open.billRequestedAt) await tx.customerOrder.update({ where: { id: open.id }, data: { billRequestedAt: null } })
        await recalcOrderTotals(tx, open.id)
        return tx.customerOrder.findUniqueOrThrow({ where: { id: open.id }, include: guestItems })
      })
      publish({
        topic: 'order', action: 'qr_received',
        organizationId: org.id, branchId: table.branchId, tableId: table.id,
        orderId: order.id, orderNo: order.orderNo, tableName: table.name,
      })
      res.status(201).json({ order: publicOrder(order) })
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'P2002' && attempt < 4) continue
      throw err
    }
  }
})

// Dishes a guest can still take back: waiting for staff to confirm, or
// confirmed but not yet started in the kitchen. Once the kitchen taps
// "Start" (preparing) the dish can no longer be cancelled from the table.
export const GUEST_CANCELLABLE = ['awaiting', 'pending']

const cancelItemsSchema = z.object({
  // the dishes to cancel; left out = everything not yet being prepared
  itemIds: z.array(z.string().min(1)).min(1).max(200).optional(),
})

// POST /public/tables/:token/cancel — { itemIds? } the guest cancels dishes
// on the table's open order before the kitchen starts on them. A table
// order left with nothing on it is closed so the table is free again.
router.post('/tables/:token/cancel', rateLimit('order-cancel', 20, 60_000), async (req: Request, res: Response) => {
  const { itemIds } = cancelItemsSchema.parse(req.body ?? {})
  const table = await tableByOrderToken(req.params.token)

  const result = await prisma.$transaction(async (tx) => {
    // same lock as placing an order and the staff screens, so a dish can't
    // be cancelled while the kitchen is starting it
    await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${table.id} FOR UPDATE`
    const open = await tx.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' }, include: { items: true } })
    if (!open) throw new AppError('There is no open order on this table.', 404, 'ORDER_NOT_FOUND')
    await assertBillEditable(tx, open.id)

    const live = open.items.filter((i) => i.status !== 'cancelled')
    const targets = itemIds ? live.filter((i) => itemIds.includes(i.id)) : live.filter((i) => GUEST_CANCELLABLE.includes(i.status))
    if (itemIds && targets.length !== new Set(itemIds).size) {
      throw new AppError('Some of these dishes are no longer on your order. Please check your order again.', 409, 'ITEM_NOT_FOUND')
    }
    const started = targets.filter((i) => !GUEST_CANCELLABLE.includes(i.status))
    if (started.length > 0) {
      const names = [...new Set(started.map((i) => i.dishName))].join(', ')
      throw new AppError(`${names} ${started.length === 1 ? 'is' : 'are'} already being prepared and can no longer be cancelled.`, 409, 'ALREADY_PREPARING')
    }
    if (targets.length === 0) {
      throw new AppError('Nothing on your order can be cancelled — the kitchen has already started on it.', 409, 'ALREADY_PREPARING')
    }

    const ids = targets.map((i) => i.id)
    await tx.customerOrderItem.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled' } })
    const emptied = !live.some((i) => !ids.includes(i.id))
    if (emptied) {
      await tx.customerOrder.update({
        where: { id: open.id },
        data: { status: 'cancelled', cancelReason: 'Cancelled by the guest from the table QR', closedAt: new Date(), billRequestedAt: null },
      })
    }
    await recalcOrderTotals(tx, open.id)
    const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: open.id }, include: guestItems })
    // accepted dishes were already on a kitchen slip — the kitchen needs a
    // cancellation slip for those; awaiting ones never reached it
    const kitchenIds = targets.filter((i) => i.status === 'pending').map((i) => i.id)
    return { order, emptied, kitchenIds, count: targets.reduce((n, i) => n + i.quantity, 0) }
  })

  publish({
    topic: 'order', action: 'guest_cancelled',
    organizationId: table.organizationId, branchId: table.branchId, tableId: table.id,
    orderId: result.order.id, orderNo: result.order.orderNo, tableName: table.name, itemIds: result.kitchenIds,
  })
  // a fully cancelled order is gone from the table — the guest sees an empty table
  res.json({ order: result.emptied ? null : publicOrder(result.order), cancelledCount: result.count })
})

// GET /public/dishes/:id/image — dish photos are shown on the public menu
router.get('/dishes/:id/image', async (req: Request, res: Response) => {
  const dish = await prisma.dish.findUnique({ where: { id: req.params.id }, select: { imagePath: true } })
  const file = resolveUpload(dish?.imagePath)
  if (!file) throw new AppError('Image not found', 404, 'NOT_FOUND')
  // The menu is served from the frontend's origin; helmet's default
  // same-origin resource policy would block the <img> otherwise.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.sendFile(file)
})

// GET /public/reviews/:token
router.get('/reviews/:token', rateLimit('review-view', 120, 60_000), async (req: Request, res: Response) => {
  const table = await tableByReviewToken(req.params.token)
  res.json({
    restaurant: { name: table.organization.tradeName || table.organization.name, logoUrl: brandingLogoUrl(table.organization) },
    branch: { name: table.organization.multiBranch ? table.branch.name : table.organization.tradeName || table.organization.name },
    table: { name: table.name },
  })
})

const reviewInclude = { items: { where: { status: { not: 'cancelled' } } }, _count: { select: { reviews: true } } }
type ReviewableOrder = Prisma.CustomerOrderGetPayload<{ include: typeof reviewInclude }>

async function findReviewableOrder(tableId: string, orderNo: number) {
  const order = await prisma.customerOrder.findFirst({ where: { tableId, orderNo }, include: reviewInclude })
  return assertReviewable(order)
}

function assertReviewable(order: ReviewableOrder | null): ReviewableOrder {
  if (!order || order.status === 'cancelled' || order.status === 'refunded') {
    throw new AppError('We could not find that order number for this table. Please check the number on your order screen or receipt.', 404, 'ORDER_NOT_FOUND')
  }
  // a meal can only be rated once it has actually reached the table
  if (!isServed(order)) {
    throw new AppError('You can rate your meal once your order has been served. Please try again after your food arrives.', 400, 'NOT_SERVED')
  }
  const ageDays = (Date.now() - order.createdAt.getTime()) / 86_400_000
  if (ageDays > REVIEW_WINDOW_DAYS) {
    throw new AppError(`Reviews can be left up to ${REVIEW_WINDOW_DAYS} days after the order.`, 400, 'REVIEW_WINDOW_CLOSED')
  }
  if (order._count.reviews >= MAX_REVIEWS_PER_ORDER) {
    throw new AppError('This order has already received the maximum number of reviews. Thank you!', 400, 'REVIEW_LIMIT')
  }
  return order
}

const orderNoSchema = z.coerce.number({ error: 'Enter your order number' }).int().positive('Enter your order number')

// POST /public/reviews/:token/lookup — { orderNo }
router.post('/reviews/:token/lookup', rateLimit('review-lookup', 30, 60_000), async (req: Request, res: Response) => {
  const orderNo = orderNoSchema.parse(req.body?.orderNo)
  const table = await tableByReviewToken(req.params.token)
  const order = await findReviewableOrder(table.id, orderNo)
  res.json({
    orderNo: order.orderNo,
    createdAt: order.createdAt,
    totalAmount: order.totalAmount,
    items: order.items.map((i) => ({ dishName: i.dishName, quantity: i.quantity })),
  })
})

const reviewSchema = z.object({
  orderNo: orderNoSchema,
  rating: z.coerce.number().int().min(1, 'Choose a star rating').max(5),
  comment: z.string().trim().min(3, 'Please write a short comment').max(1000),
  guestName: z.string().trim().max(40).optional(),
})

// POST /public/reviews/:token — multipart: orderNo, rating, comment, guestName?, image?
router.post('/reviews/:token', rateLimit('review-submit', 5, 60_000), imageUpload('reviews').single('image'), async (req: Request, res: Response) => {
  try {
    const body = reviewSchema.parse(req.body)
    const table = await tableByReviewToken(req.params.token)
    const order = await findReviewableOrder(table.id, body.orderNo)
    await prisma.orderReview.create({
      data: {
        organizationId: table.organizationId,
        branchId: table.branchId,
        tableId: table.id,
        orderId: order.id,
        rating: body.rating,
        comment: body.comment,
        guestName: body.guestName || null,
        imagePath: req.file?.path ?? null,
      },
    })
    publish({
      topic: 'review', action: 'created', organizationId: table.organizationId, branchId: table.branchId,
      tableId: table.id, orderId: order.id, orderNo: order.orderNo, tableName: table.name,
    })
    res.status(201).json({ message: 'Thank you for your review!' })
  } catch (err) {
    removeUpload(req.file?.path)
    throw err
  }
})

// ── Review from the QR printed on a receipt ──────────────────────────────
// Works for every order — dine-in and takeaway — without typing an order
// number: the link carries a signed order id (see utils/reviewCode.ts).

async function orderByReviewCode(code: string) {
  const orderId = parseReviewCode(code)
  const order = orderId
    ? await prisma.customerOrder.findUnique({
      where: { id: orderId },
      include: { ...reviewInclude, organization: true, branch: true, table: { select: { id: true, name: true } } },
    })
    : null
  if (!order || !order.organization.isActive) throw new AppError('This review link is not valid.', 404, 'ORDER_NOT_FOUND')
  return order
}

// GET /public/order-review/:code — who is being reviewed, plus the order
router.get('/order-review/:code', rateLimit('review-view', 120, 60_000), async (req: Request, res: Response) => {
  const order = await orderByReviewCode(req.params.code)
  assertReviewable(order)
  res.json({
    restaurant: { name: order.organization.tradeName || order.organization.name, logoUrl: brandingLogoUrl(order.organization) },
    branch: { name: order.organization.multiBranch ? order.branch.name : order.organization.tradeName || order.organization.name },
    place: order.orderType === 'takeaway' ? 'Takeaway' : order.orderType === 'delivery' ? 'Delivery' : order.table ? `Table ${order.table.name}` : 'Dine-in',
    order: {
      orderNo: order.orderNo,
      createdAt: order.createdAt,
      totalAmount: order.totalAmount,
      items: order.items.map((i) => ({ dishName: i.dishName, quantity: i.quantity })),
    },
  })
})

const codeReviewSchema = reviewSchema.omit({ orderNo: true })

// POST /public/order-review/:code — multipart: rating, comment, guestName?, image?
router.post('/order-review/:code', rateLimit('review-submit', 5, 60_000), imageUpload('reviews').single('image'), async (req: Request, res: Response) => {
  try {
    const body = codeReviewSchema.parse(req.body)
    const order = await orderByReviewCode(req.params.code)
    assertReviewable(order)
    await prisma.orderReview.create({
      data: {
        organizationId: order.organizationId,
        branchId: order.branchId,
        tableId: order.tableId,
        orderId: order.id,
        rating: body.rating,
        comment: body.comment,
        guestName: body.guestName || null,
        imagePath: req.file?.path ?? null,
      },
    })
    publish({
      topic: 'review', action: 'created', organizationId: order.organizationId, branchId: order.branchId,
      tableId: order.tableId, orderId: order.id, orderNo: order.orderNo, tableName: order.table?.name ?? null,
    })
    res.status(201).json({ message: 'Thank you for your review!' })
  } catch (err) {
    removeUpload(req.file?.path)
    throw err
  }
})

export default router
