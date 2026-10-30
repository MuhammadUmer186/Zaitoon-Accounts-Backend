import { moneyUnit, moneyTolerance, moneyFactor } from '../utils/money'
import { estimatedReadyAfterPayment } from './orderPaymentPolicy'
import { assertCounter } from './posCounters'
import { Prisma } from '@prisma/client'
import { Request } from 'express'
import { z } from 'zod'
import { AppError } from '../middleware/error'
import { prisma } from '../config'
import { lockOrder, orderInclude, assertBillEditable } from '../routes/orders'
import { recordPayment, round2, PaymentPart, lockCashier } from './tills'
import { costAndConsumeOrder, restoreOrderStock } from './foodCost'
import { addOrderToDailySale, recomputeOrdersSale } from './orderSales'
import { authorizePos } from './posSecurity'
import { getUserPermissions } from '../utils/permissions'
import { recalcOrderTotals } from '../utils/menu'
import { logAudit } from '../utils/audit'
import { computeTotals, InvoiceLine } from './zatca/invoice'
import { earnLoyalty, reverseLoyaltyEarn } from './tenders'
import { assertPromotionCombination } from './promotions'
import { recordVisit, reverseVisit } from './customers'

type Tx = Prisma.TransactionClient
export const splitSchema = z.object({
  mode: z.enum(['equal', 'amount', 'items']),
  count: z.number().int().min(2).max(30).optional(),
  checks: z.array(z.object({ label: z.string().trim().min(1).max(60), amount: z.number().finite().positive().optional(), itemIds: z.array(z.string().min(1)).min(1).max(200).optional() })).min(2).max(30).optional(),
  discountAmount: z.number().finite().min(0).default(0),
  discountReason: z.string().trim().min(3).max(200).optional(),
  approvalToken: z.string().optional(),
})

// Largest-remainder allocation in minor units: every cent belongs to exactly
// one check, including discounts and recipe cost.
export function allocate(amount: number, weights: number[]) {
  const cents = Math.round(amount * moneyFactor()), total = weights.reduce((a, b) => a + b, 0)
  if (!Number.isSafeInteger(cents) || cents < 0 || total <= 0) throw new AppError('Invalid check amounts', 400, 'INVALID_SPLIT')
  const raw = weights.map((w) => cents * w / total), units = raw.map(Math.floor)
  const rank = raw.map((v, i) => ({ i, fraction: v - units[i] })).sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  for (let n = cents - units.reduce((a, b) => a + b, 0), i = 0; i < n; i++) units[rank[i].i]++
  return units.map((n) => n / moneyFactor())
}

export async function createChecks(tx: Tx, req: Request, id: string, body: z.infer<typeof splitSchema>) {
  const found = await tx.customerOrder.findUniqueOrThrow({ where: { id } })
  await lockOrder(tx, found)
  await assertBillEditable(tx, id)
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id }, include: { items: { where: { status: { not: 'cancelled' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, organization: true } })
  if (order.status !== 'open' || order.orderType !== 'dine_in') throw new AppError('Separate checks require an open dine-in order', 409, 'INVALID_STATUS')
  if (!order.items.length || order.items.some((i) => i.status === 'awaiting')) throw new AppError('Accept or reject all dishes before splitting the bill', 409, 'NOT_ACCEPTED')
  if (body.discountAmount > order.itemsTotal) throw new AppError('Discount exceeds food total', 400, 'INVALID_DISCOUNT')
  await assertPromotionCombination(tx, order.organizationId, body.discountAmount, order.promotionAmount)
  if (body.discountAmount > 0 && !body.discountReason) throw new AppError('Enter a discount reason', 400, 'INVALID_DISCOUNT')
  const { permissions } = await getUserPermissions(tx, req.user.id)
  if (body.discountAmount > order.itemsTotal * order.organization.maxStaffDiscountPct / 100 + 0.001 && !permissions.has('can_apply_discount')) await authorizePos(tx, req, 'discount', order.branchId, id, body.approvalToken)
  await tx.customerOrder.update({ where: { id }, data: { discountAmount: body.discountAmount, discountReason: body.discountReason ?? null } })
  const totals = await recalcOrderTotals(tx, id)
  let groups = body.checks
  if (body.mode === 'equal') {
    if (!body.count) throw new AppError('Choose how many equal checks', 400, 'INVALID_SPLIT')
    groups = allocate(totals.totalAmount, Array(body.count).fill(1)).map((amount, n) => ({ label: `Guest ${n + 1}`, amount }))
  }
  if (!groups?.length) throw new AppError('Provide separate checks', 400, 'INVALID_SPLIT')
  let weights: number[]
  if (body.mode === 'items') {
    const ids = groups.flatMap((g) => g.itemIds ?? [])
    if (groups.some((g) => !g.itemIds?.length) || ids.length !== order.items.length || new Set(ids).size !== ids.length || ids.some((id) => !order.items.some((i) => i.id === id))) throw new AppError('Assign every active dish line to exactly one check', 400, 'INVALID_SPLIT')
    weights = groups.map((g) => round2(order.items.filter((i) => g.itemIds!.includes(i.id)).reduce((n, i) => n + i.lineTotal, 0)))
  } else {
    weights = groups.map((g) => round2(g.amount ?? 0))
    if (Math.abs(round2(weights.reduce((a, b) => a + b, 0)) - totals.totalAmount) > moneyTolerance()) throw new AppError('Check amounts must equal the bill', 400, 'PAYMENT_MISMATCH')
  }
  const gross = body.mode === 'items' ? weights : allocate(totals.itemsTotal, weights)
  // the staff discount and promotions are shared out together
  const discounts = allocate(round2(totals.discountAmount + totals.promotionAmount), weights)
  // Amount/equal checks preserve the requested amount, rather than allowing
  // independent rounding of their allocated gross and discount to move it.
  const payable = body.mode === 'items' ? gross.map((g, n) => round2(g - discounts[n])) : weights
  let tax = 0
  for (const [n, group] of groups.entries()) {
    if (payable[n] < moneyUnit()) throw new AppError('Each check must have a positive amount', 400, 'INVALID_SPLIT')
    const itemsTotal = round2(payable[n] + discounts[n])
    const selected = body.mode === 'items' ? order.items.filter((i) => group.itemIds!.includes(i.id)) : order.items
    let lines: InvoiceLine[]
    if (body.mode === 'items') lines = selected.map((i) => ({ name: i.dishName, quantity: i.quantity, unitPriceInclusive: i.unitPrice }))
    else {
      const amounts = allocate(itemsTotal, selected.map((i) => i.lineTotal))
      lines = selected.flatMap((i, j) => amounts[j] > 0 ? [{ name: `Share of ${i.quantity} × ${i.dishName}`, quantity: 1, unitPriceInclusive: amounts[j] }] : [])
    }
    const fiscal = order.organization.zatcaEnabled ? computeTotals({ lines, discountInclusive: discounts[n], vatRate: totals.vatRate, payableInclusive: payable[n] } as Parameters<typeof computeTotals>[0]) : null
    if (fiscal && Math.abs(fiscal.payable - payable[n]) > moneyTolerance()) throw new AppError('This split needs too much invoice rounding. Use fewer check lines or a different split', 400, 'CHECK_ROUNDING')
    const vatAmount = fiscal?.vat ?? round2(payable[n] * totals.vatRate / (100 + totals.vatRate))
    tax += vatAmount
    await tx.orderCheck.create({ data: {
      organizationId: order.organizationId, branchId: order.branchId, orderId: id, number: n + 1,
      label: group.label, mode: body.mode, itemIds: body.mode === 'items' ? group.itemIds : [], lines: lines as unknown as Prisma.InputJsonValue,
      itemsTotal, discountAmount: discounts[n], totalAmount: payable[n], vatRate: totals.vatRate, vatAmount,
    } })
  }
  await tx.customerOrder.update({ where: { id }, data: { vatAmount: round2(tax), subtotal: round2(totals.totalAmount - tax) } })
  await logAudit(tx, { req, action: 'split_bill', module: 'orders', resourceType: 'customer_order', resourceId: id, branchId: order.branchId, newData: { mode: body.mode, count: groups.length, total: totals.totalAmount, discount: totals.discountAmount } })
  return tx.customerOrder.findUniqueOrThrow({ where: { id }, include: orderInclude })
}

export const payCheckSchema = z.object({
  counterCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,30}$/).optional(),
  payments: z.array(z.object({ method: z.enum(['cash', 'card', 'mada', 'bank_transfer', 'other']), amount: z.number().finite().positive() })).min(1).max(6),
  amountTendered: z.number().finite().min(0).optional(),
})

export async function payCheck(tx: Tx, req: Request, orderId: string, checkId: string, body: z.infer<typeof payCheckSchema>) {
  await lockOrder(tx, await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } }))
  // status, table and branch as they are under the lock (a concurrent refund,
  // transfer or final payment may have committed while this one waited)
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } })
  const check = await tx.orderCheck.findFirst({ where: { id: checkId, orderId } })
  if (!check) throw new AppError('Check not found', 404, 'NOT_FOUND')
  await assertCounter(tx, order, body.counterCode ?? order.counterCode)
  const payments = body.payments.map((p) => ({ ...p, amount: round2(p.amount) }))
  if (payments.some((p) => p.amount < moneyUnit()) || Math.abs(round2(payments.reduce((a, p) => a + p.amount, 0)) - check.totalAmount) > moneyTolerance()) throw new AppError('Payments must equal this check', 400, 'PAYMENT_MISMATCH')
  const cash = round2(payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0))
  if (cash > 0 && body.amountTendered != null && round2(body.amountTendered) < cash) throw new AppError('Cash received is below the check amount', 400, 'PAYMENT_MISMATCH')
  if (check.status === 'paid') {
    const signature = (parts: PaymentPart[]) => parts.map((p) => `${p.method}:${Math.round(p.amount * moneyFactor())}`).sort().join('|')
    if (signature(check.payments as unknown as PaymentPart[]) !== signature(payments)) throw new AppError('This check was already paid differently', 409, 'CHECK_ALREADY_PAID')
    return tx.customerOrder.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })
  }
  if (check.status !== 'unpaid' || order.status !== 'open') throw new AppError('This check cannot be paid', 409, 'INVALID_STATUS')
  // Serialize against closing approval; never change an approved cash day.
  await lockCashier(tx, order.branchId, req.user.id)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-settlement:${order.branchId}`}))`
  const { businessDate } = await import('./orderSales')
  const org = await tx.organization.findUniqueOrThrow({ where: { id: order.organizationId } })
  const day = businessDate(org.timezone)
  if (await tx.cashClosing.count({ where: { branchId: order.branchId, closingDate: day, status: 'approved' } })) throw new AppError('Reopen the cash closing before taking payment', 409, 'CLOSING_APPROVED')
  await recordPayment(tx, req, order, payments, 'sale', `check:${check.id}`, { checkId })
  const priorPaid = await tx.orderCheck.count({ where: { orderId, status: 'paid' } })
  if (!priorPaid) {
    const costed = await costAndConsumeOrder(tx, orderId, req.user.id)
    const checks = await tx.orderCheck.findMany({ where: { orderId }, orderBy: { number: 'asc' } })
    const costs = allocate(costed.foodCost, checks.map((c) => c.totalAmount))
    for (const [n, c] of checks.entries()) await tx.orderCheck.update({ where: { id: c.id }, data: { foodCost: costs[n] } })
  }
  await tx.orderCheck.update({ where: { id: checkId }, data: { status: 'paid', counterCode: body.counterCode ?? order.counterCode, payments, paidAt: new Date(), paidBy: req.user.id, amountTendered: cash > 0 ? body.amountTendered ?? null : null, changeAmount: cash > 0 && body.amountTendered != null ? round2(body.amountTendered - cash) : null } })
  await addOrderToDailySale(tx, orderId, req.user.id, checkId)
  const checks = await tx.orderCheck.findMany({ where: { orderId } })
  const allPaid = checks.every((c) => c.status === 'paid')
  const fullyPaidAt = new Date()
  const paid = checks.filter((c) => c.status === 'paid').flatMap((c) => c.payments as unknown as PaymentPart[])
  await tx.customerOrder.update({ where: { id: orderId }, data: { payments: paid as unknown as Prisma.InputJsonValue, paymentMethod: 'split', ...(allPaid && { status: 'completed', closedAt: fullyPaidAt, estimatedReadyAt: estimatedReadyAfterPayment(order, fullyPaidAt), closedBy: req.user.id }) } })
  if (allPaid && order.tableId) await tx.diningTable.update({ where: { id: order.tableId }, data: { needsClearing: true } })
  if (allPaid) {
    // the whole visit, once: spend and points on everything the checks paid
    const closed = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } })
    await recordVisit(tx, closed)
    await earnLoyalty(tx, req, closed, paid)
  }
  await logAudit(tx, { req, action: 'pay_check', module: 'orders', resourceType: 'order_check', resourceId: checkId, branchId: order.branchId, newData: { orderId, amount: check.totalAmount, payments } })
  return tx.customerOrder.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })
}

// Refund the split as a group, even if only some checks were paid. This keeps
// shared dishes/recipe stock unambiguous; no refund exceeds actual receipts.
export async function refundChecks(tx: Tx, req: Request, orderId: string, reason: string, approvalToken?: string) {
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } })
  await lockOrder(tx, order)
  const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId }, include: { checks: true } })
  if (!['open', 'completed'].includes(fresh.status) || !fresh.checks.some((c) => c.status === 'paid')) throw new AppError('No paid checks to refund', 409, 'INVALID_STATUS')
  await authorizePos(tx, req, 'refund', order.branchId, orderId, approvalToken)
  await lockCashier(tx, order.branchId, req.user.id)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-settlement:${order.branchId}`}))`
  const { businessDate } = await import('./orderSales')
  const org = await tx.organization.findUniqueOrThrow({ where: { id: order.organizationId }, select: { timezone: true } })
  if (await tx.cashClosing.count({ where: { branchId: order.branchId, closingDate: businessDate(org.timezone), status: 'approved' } })) throw new AppError('Reopen the cash closing before refunding checks', 409, 'CLOSING_APPROVED')
  const saleIds = [...new Set(fresh.checks.filter((c) => c.dailySaleId).map((c) => c.dailySaleId!))].sort()
  for (const id of saleIds) {
    await tx.$queryRaw`SELECT id FROM "DailySale" WHERE id = ${id} FOR UPDATE`
    const sale = await tx.dailySale.findUniqueOrThrow({ where: { id } })
    if (sale.status !== 'draft') throw new AppError('A check is in finalized Daily Sales; record its adjustment there', 409, 'SALE_FINALIZED')
  }
  for (const c of fresh.checks.filter((c) => c.status === 'paid')) {
    await recordPayment(tx, req, order, c.payments as unknown as PaymentPart[], 'refund', `check:${c.id}`, { checkId: c.id })
    await tx.orderCheck.update({ where: { id: c.id }, data: { status: 'refunded', refundedAt: new Date(), dailySaleId: null } })
  }
  await tx.orderCheck.updateMany({ where: { orderId, status: 'unpaid' }, data: { status: 'void' } })
  // a completed visit is taken back with the points it earned
  if (fresh.status === 'completed') await reverseVisit(tx, fresh)
  await reverseLoyaltyEarn(tx, req, fresh.organizationId, orderId)
  for (const id of saleIds) await recomputeOrdersSale(tx, id)
  await restoreOrderStock(tx, orderId, req.user.id)
  await tx.customerOrderItem.updateMany({ where: { orderId, status: { in: ['pending', 'preparing', 'ready'] } }, data: { status: 'cancelled' } })
  await tx.customerOrder.update({ where: { id: orderId }, data: { status: 'refunded', cancelReason: reason, closedAt: fresh.closedAt ?? new Date(), closedBy: req.user.id } })
  if (order.tableId) await tx.diningTable.update({ where: { id: order.tableId }, data: { needsClearing: true } })
  await logAudit(tx, { req, action: 'refund_checks', module: 'orders', resourceType: 'customer_order', resourceId: orderId, branchId: order.branchId, newData: { reason, checks: fresh.checks.filter((c) => c.status === 'paid').map((c) => c.id) } })
  return tx.customerOrder.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })
}

export const splitOrder = (req: Request, id: string, body: z.infer<typeof splitSchema>) => prisma.$transaction((tx) => createChecks(tx, req, id, body))
