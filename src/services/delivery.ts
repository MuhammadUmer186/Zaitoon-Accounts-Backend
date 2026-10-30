import { moneyTolerance as regionalMoneyTolerance } from '../utils/money'
import { Request } from 'express'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { completeOrderInTransaction, completeOrderSchema, lockOrder, orderInclude } from '../routes/orders'
import { businessDate } from './orderSales'

// asRiderId: the rider updating their own delivery from the rider login
export async function transitionDelivery(req: Request, orderId: string, body: { status: 'assigned' | 'picked_up' | 'delivered' | 'failed'; riderId?: string; reason?: string; cashCollected?: number }, opts: { asRiderId?: string } = {}) {
  const orgId = req.user.organizationId
  const existing = await prisma.customerOrder.findFirst({ where: { id: orderId, organizationId: orgId, orderType: 'delivery' } })
  if (!existing) throw new AppError('Delivery order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, existing.branchId)
  return prisma.$transaction(async (tx) => {
    // Read assignment again after the order lock; all fulfillment transitions
    // share this lock with checkout, cancellation, item edits and refunds.
    await lockOrder(tx, existing)
    let order = await tx.customerOrder.findUniqueOrThrow({ where: { id: existing.id }, include: { items: true } })
    if (opts.asRiderId && (order.riderId !== opts.asRiderId || body.status === 'assigned')) throw new AppError('This delivery is not assigned to you', 403, 'NOT_YOUR_DELIVERY')
    if (!['open', 'completed'].includes(order.status)) throw new AppError('Accept the order before dispatching; cancelled/refunded orders cannot be dispatched', 409, 'INVALID_STATUS')
    const before = order.deliveryStatus ?? 'unassigned'
    const riderId = body.status === 'assigned' ? body.riderId : order.riderId
    const rider = riderId ? await tx.rider.findFirst({ where: { id: riderId, organizationId: orgId, branchId: order.branchId } }) : null
    if (!rider) throw new AppError('Choose an active rider from this branch', 409, 'RIDER_UNAVAILABLE')
    if (before === body.status && (body.status !== 'assigned' || order.riderId === rider.id)) {
      const cash = await tx.riderCashCollection.findUnique({ where: { orderId } })
      if (body.status === 'delivered' && cash && body.cashCollected !== cash.amount) throw new AppError('The recorded cash collection cannot be changed by retrying', 409, 'DELIVERY_CASH_CONFLICT')
      return { order: await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude }), duplicate: true }
    }
    await tx.$queryRaw`SELECT id FROM "Rider" WHERE id = ${rider.id} FOR UPDATE`
    if (body.status !== 'failed' && !await tx.rider.count({ where: { id: rider.id, active: true } })) throw new AppError('Rider is inactive', 409, 'RIDER_UNAVAILABLE')
    const allowed = body.status === 'assigned' ? ['unassigned', 'assigned', 'failed'] : body.status === 'picked_up' ? ['assigned'] : body.status === 'delivered' ? ['picked_up'] : ['assigned', 'picked_up']
    if (!allowed.includes(before)) throw new AppError(`Cannot change ${before} to ${body.status}`, 409, 'INVALID_DELIVERY_STATUS')
    if (body.status === 'failed' && (body.reason?.length ?? 0) < 3) throw new AppError('Explain why delivery failed', 400, 'DELIVERY_REASON_REQUIRED')
    if (body.status === 'picked_up' && order.items.some((i) => i.status !== 'cancelled' && (i.held || !['ready', 'served'].includes(i.status)))) throw new AppError('The kitchen must mark every active dish ready before pickup', 409, 'KITCHEN_NOT_READY')
    // Every delivery, including older COD records, requires full prepayment.
    if (body.status === 'picked_up' && order.status !== 'completed') throw new AppError('Full payment is required before kitchen preparation and rider pickup', 409, 'DELIVERY_UNPAID')
    if (body.status === 'delivered') {
      // Reconcile only legacy COD deliveries already dispatched before payment-first.
      if (order.deliveryPaymentMode === 'cod' && order.status !== 'completed') {
        if (body.cashCollected === undefined || Math.abs(body.cashCollected - order.totalAmount) > regionalMoneyTolerance()) throw new AppError('Confirm the full cash amount collected from the customer; record failed delivery if it was not paid', 400, 'DELIVERY_CASH_MISMATCH')
        const result = await completeOrderInTransaction(tx, req, order, completeOrderSchema.parse({ paymentMethod: 'cash' }), undefined, undefined, true)
        const payment = await tx.tillPayment.findUniqueOrThrow({ where: { referenceKey: `sale:${order.id}:0` } })
        const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } })
        await tx.riderCashCollection.create({ data: { organizationId: orgId, branchId: order.branchId, riderId: rider.id, orderId: order.id, tillPaymentId: payment.id, amount: result.updated.totalAmount, businessDate: businessDate(org.timezone, result.updated.closedAt!), collectedAt: result.updated.closedAt! } })
        order = { ...order, ...result.updated }
      } else if (order.status !== 'completed') throw new AppError('Take payment before completing a prepaid delivery', 409, 'DELIVERY_UNPAID')
    }
    const updated = await tx.customerOrder.update({ where: { id: order.id }, data: {
      deliveryStatus: body.status, riderId: rider.id,
      ...(body.status === 'assigned' && { dispatchedAt: null, deliveredAt: null, deliveryFailureReason: null }),
      ...(body.status === 'picked_up' && { dispatchedAt: new Date() }),
      ...(body.status === 'delivered' && { deliveredAt: new Date() }),
      ...(body.status === 'failed' && { deliveryFailureReason: body.reason }),
    }, include: orderInclude })
    await tx.deliveryEvent.create({ data: { orderId: order.id, fromStatus: before, toStatus: body.status, riderId: rider.id, riderName: rider.name, userId: req.user.id, reason: body.reason } })
    await logAudit(tx, { req, action: `delivery_${body.status}`, module: 'delivery', branchId: order.branchId, resourceId: order.id, newData: { ...body, riderId: rider.id } })
    return { order: updated, duplicate: false }
  })
}
