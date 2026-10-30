import { roundMoney, runWithCurrency } from '../utils/money'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { lineSelectionSchema, loadDishOptions, priceSelection, resolveStations } from './menuOptions'
import { ensureShifts, currentShift, nextOrderNo, recalcOrderTotals } from '../utils/menu'
import { ONLINE_ORDER_TYPES, enabledOnlineOrderTypes, onlineOrderId } from '../utils/onlineOrder'
import { publish } from '../utils/liveEvents'
import { publicOrder } from '../routes/public'
import { deliveryQuote } from './deliveryPricing'
import { paymentStatus } from './payments'
import { readyForPayment } from './orderPaymentPolicy'
import { linkCustomer } from './customers'

export const brandOrg = () => prisma.organization.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } })
export async function publicBranch(id: string) {
  const org = await brandOrg()
  const branch = org && await prisma.branch.findFirst({ where: { id, organizationId: org.id, isActive: true } })
  if (!org || !branch) throw new AppError('This branch is unavailable.', 404, 'BRANCH_NOT_FOUND')
  return { org, branch }
}

export const onlineOrderSchema = z.object({
  requestId: z.string().uuid(),
  // carts saved by older menu pages carry no type — they were pickup orders
  orderType: z.enum(ONLINE_ORDER_TYPES).default('takeaway'),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryZoneId: z.string().min(1).optional(),
  deliveryArea: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
  customerName: z.string().trim().min(1, 'Enter your name').max(60),
  customerPhone: z.string().trim().min(7, 'Enter your phone number').max(30).regex(/^\+?[0-9 ()-]+$/, 'Enter a valid phone number')
    .refine((phone) => { const digits = phone.replace(/\D/g, '').length; return digits >= 7 && digits <= 15 }, 'Enter a phone number with 7 to 15 digits'),
  items: z.array(z.object({ dishId: z.string().min(1), quantity: z.number().int().min(1).max(50), notes: z.string().trim().max(200).optional(), ...lineSelectionSchema })).min(1).max(50),
}).superRefine((body, ctx) => {
  if (body.orderType === 'delivery' && (body.deliveryAddress ?? '').length < 5) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryAddress'], message: 'Enter your full delivery address' })
  }
})
export type OnlineOrderInput = z.infer<typeof onlineOrderSchema>

// Commits an online order in THIS database. The cloud route and the branch PC's
// command relay both use it, so a replayed command finds the same order again.
export async function placeOnlineOrder(branchId: string, body: OnlineOrderInput) {
  const { org, branch } = await publicBranch(branchId)
  return runWithCurrency(org.currency, async () => {
  const id = onlineOrderId(branch.id, body.requestId)
  const typeOffered = enabledOnlineOrderTypes(org).includes(body.orderType)
  for (let attempt = 0; ; attempt++) {
    try {
      let created = false
      const order = await prisma.$transaction(async (tx) => {
        // Serialize retries without merging independent customers' orders.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`
        const existing = await tx.customerOrder.findUnique({ where: { id }, include: { items: true } })
        if (existing) return existing
        // checked after the retry lookup: an order already placed stands even
        // if the type was switched off a moment later
        if (!typeOffered) throw new AppError('This order type is not available right now. Please choose another option.', 400, 'ORDER_TYPE_UNAVAILABLE')
        const shift = currentShift(await ensureShifts(tx, org.id), org.timezone)
        if (!shift) throw new AppError('Ordering is closed right now. Please return during opening hours.', 400, 'NO_ACTIVE_SHIFT')
        const dishIds = [...new Set(body.items.map((i) => i.dishId))]
        const dishes = await tx.dish.findMany({ where: {
          id: { in: dishIds }, organizationId: org.id, isActive: true, category: { isActive: true },
          shifts: { some: { shiftId: shift.id } }, outOfStock: { none: { branchId: branch.id } },
        } })
        const dishMap = new Map(dishes.map((d) => [d.id, d]))
        if (dishIds.some((dishId) => !dishMap.has(dishId))) throw new AppError('Some dishes are no longer available. Refresh the menu and update your cart.', 409, 'DISH_UNAVAILABLE')
        const options = await loadDishOptions(tx, dishIds)
        const stations = await resolveStations(tx, org.id, dishIds)
        const off = new Set((await tx.dishOutOfStock.findMany({ where: { branchId: branch.id }, select: { dishId: true } })).map((o) => o.dishId))
        const delivery = await deliveryQuote(tx, org.id, branch, body.orderType, body.deliveryZoneId, body.deliveryArea)
        await tx.customerOrder.create({ data: {
          id, organizationId: org.id, branchId: branch.id, shiftId: shift.id,
          // online orders wait for a staff member to accept them before the
          // kitchen sees them
          orderNo: await nextOrderNo(tx, org.id, branch.id), orderType: body.orderType, source: 'online', status: 'pending',
          customerName: body.customerName, customerPhone: body.customerPhone,
          customerId: await linkCustomer(tx, org.id, body.customerPhone, body.customerName),
          deliveryAddress: body.orderType === 'delivery' ? body.deliveryAddress : null,
          ...delivery,
          deliveryPaymentMode: body.orderType === 'delivery' ? 'prepaid' : null,
          notes: body.notes || null,
          items: { create: body.items.map((i) => {
            const dish = dishMap.get(i.dishId)!
            const { unitPrice, selection } = priceSelection(dish, options.get(dish.id), i, off)
            return { dishId: dish.id, dishName: dish.name, unitPrice, quantity: i.quantity,
              lineTotal: roundMoney(unitPrice * i.quantity), notes: i.notes || null, selection: (selection ?? Prisma.JsonNull) as Prisma.InputJsonValue, stationId: stations.get(dish.id) ?? null }
          }) },
        } })
        await recalcOrderTotals(tx, id, { enforceMinimum: true })
        created = true
        return tx.customerOrder.findUniqueOrThrow({ where: { id }, include: { items: true } })
      })
      if (created) publish({ topic: 'order', action: 'online_received', organizationId: org.id, branchId: branch.id, orderId: order.id, orderNo: order.orderNo, tableId: null, tableName: null })
      return { created, order }
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002' && attempt < 4) continue
      throw err
    }
  }
  })
}

export async function trackedOnlineOrder(id: string | null) {
  const org = await brandOrg()
  const order = id && org && await prisma.customerOrder.findFirst({
    where: { id, organizationId: org.id, source: 'online' },
    include: { items: true, checks: { orderBy: { number: 'asc' } }, branch: { select: { phone: true, isActive: true } } },
  })
  if (!order) throw new AppError('Order tracking link is invalid.', 404, 'ORDER_NOT_FOUND')
  return order
}

export async function onlineOrderView(order: Awaited<ReturnType<typeof trackedOnlineOrder>>) {
  const payments = await paymentStatus(prisma, order.organizationId)
  return {
    ...publicOrder(order), paymentsAvailable: order.branch.isActive && payments.active && payments.channels.includes('qr'),
    payable: readyForPayment(order), branchPhone: order.branch.phone,
    checks: order.checks.map(({ id, number, label, totalAmount, status }) => ({ id, number, label, totalAmount, status })),
  }
}
