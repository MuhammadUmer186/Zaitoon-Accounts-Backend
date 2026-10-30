import { runWithCurrency } from '../utils/money'
import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'
import { nextNumber } from '../utils/numbering'
import { isValidTimezone } from '../utils/menu'

type Tx = Prisma.TransactionClient

// Completed POS / QR orders feed Daily Sales, so the dashboard, reports,
// cash closing and the ledger all see order revenue without a second set of
// numbers:
//
//   - every branch + business day gets an automatic Daily Sale with
//     source "orders", kept as a draft while the day is trading;
//   - its amounts are rebuilt from the orders linked to it (payments split by
//     method), every time an order is completed or refunded;
//   - a manager finalizes the day by submitting it (posts the journal entry);
//     orders completed after that start a new draft for the same day, so a
//     posted entry is never changed underneath the ledger.

const round2 = (n: number) => regionalRoundMoney(n)

// The restaurant's calendar date for a moment, stored the way Daily Sales
// stores sale dates (midnight UTC of that date).
export function businessDate(timezone: string, at: Date = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimezone(timezone) ? timezone : 'Asia/Karachi',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
  return new Date(`${ymd}T00:00:00.000Z`)
}

type AmountField = 'cashAmount' | 'cardAmount' | 'bankTransferAmount' | 'otherAmount' | 'giftCardAmount' | 'loyaltyAmount' | 'houseAccountAmount'
const METHOD_FIELD: Record<string, AmountField> = {
  cash: 'cashAmount',
  card: 'cardAmount',
  mada: 'cardAmount',
  bank_transfer: 'bankTransferAmount',
  other: 'otherAmount',
  // not money in the drawer: the sales journal debits the gift card /
  // loyalty liability or the customer's receivable instead
  gift_card: 'giftCardAmount',
  loyalty: 'loyaltyAmount',
  house_account: 'houseAccountAmount',
}

// Rebuilds an automatic Daily Sale from its linked completed orders. A draft
// left with no orders (e.g. its only order was refunded) is removed.
export async function recomputeOrdersSale(tx: Tx, dailySaleId: string) {
  await tx.$queryRaw`SELECT id FROM "DailySale" WHERE id = ${dailySaleId} FOR UPDATE`
  const sale = await tx.dailySale.findUnique({ where: { id: dailySaleId }, include: { branch: { select: { vatEnabled: true, vatRate: true } } } })
  if (!sale || sale.source !== 'orders') return null
  if (sale.status !== 'draft') throw new AppError('This day is already finalized in Daily Sales', 400, 'SALE_FINALIZED')
  const org = await tx.organization.findUniqueOrThrow({ where: { id: sale.organizationId }, select: { currency: true } })
  return runWithCurrency(org.currency, async () => {

  const orders = await tx.customerOrder.findMany({ where: { dailySaleId, status: 'completed' } })
  const checks = await tx.orderCheck.findMany({ where: { dailySaleId, status: 'paid' } })
  if (orders.length === 0 && checks.length === 0) {
    await tx.dailySale.delete({ where: { id: dailySaleId } })
    return null
  }

  const amounts: Record<AmountField, number> = { cashAmount: 0, cardAmount: 0, bankTransferAmount: 0, otherAmount: 0, giftCardAmount: 0, loyaltyAmount: 0, houseAccountAmount: 0 }
  let itemsTotal = 0, discount = 0, vat = 0, total = 0, cost = 0
  for (const o of orders) {
    // split bills carry their payment lines; older orders a single method
    const lines = Array.isArray(o.payments) && o.payments.length
      ? (o.payments as { method: string; amount: number }[])
      : [{ method: o.paymentMethod ?? 'cash', amount: o.totalAmount }]
    for (const p of lines) amounts[METHOD_FIELD[p.method] ?? 'cashAmount'] += Number(p.amount) || 0
    itemsTotal += (o.itemsTotal || o.totalAmount + o.discountAmount) + o.deliveryFee
    discount += o.discountAmount + o.promotionAmount
    vat += o.vatAmount
    total += o.totalAmount
    cost += o.foodCost
  }
  for (const c of checks) {
    for (const p of (c.payments as { method: string; amount: number }[])) amounts[METHOD_FIELD[p.method] ?? 'otherAmount'] += p.amount
    itemsTotal += c.itemsTotal
    discount += c.discountAmount
    vat += c.vatAmount
    total += c.totalAmount
    cost += c.foodCost
  }
  const dineIn = orders.filter((o) => o.orderType === 'dine_in').length
  const delivery = orders.filter((o) => o.orderType === 'delivery').length
  const takeaway = orders.length - dineIn - delivery

  return tx.dailySale.update({
    where: { id: dailySaleId },
    data: {
      cashAmount: round2(amounts.cashAmount),
      cardAmount: round2(amounts.cardAmount),
      bankTransferAmount: round2(amounts.bankTransferAmount),
      otherAmount: round2(amounts.otherAmount),
      giftCardAmount: round2(amounts.giftCardAmount),
      loyaltyAmount: round2(amounts.loyaltyAmount),
      houseAccountAmount: round2(amounts.houseAccountAmount),
      deliveryAmount: 0,
      // subtotal = value of items sold, before discounts (as on the manual form)
      subtotal: round2(itemsTotal),
      discountAmount: round2(discount),
      vatAmount: round2(vat),
      vatRate: sale.branch.vatEnabled ? sale.branch.vatRate : 0,
      totalAmount: round2(total),
      refundAmount: 0,
      netAmount: round2(total),
      costOfSales: round2(cost),
      notes: `Automatic — ${orders.length} orders (${dineIn} dine-in, ${takeaway} takeaway${delivery ? `, ${delivery} delivery` : ''})${checks.length ? `, ${checks.length} paid checks` : ''}`,
    },
  })
  })
}

// Counts a just-completed order in its branch's open "orders" Daily Sale for
// the business day it was paid on, creating that draft if needed.
export async function addOrderToDailySale(tx: Tx, orderId: string, userId: string, checkId?: string) {
  const order = await tx.customerOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { organization: { select: { timezone: true } }, branch: { select: { salePrefix: true, vatEnabled: true, vatRate: true } } },
  })
  const check = checkId ? await tx.orderCheck.findUniqueOrThrow({ where: { id: checkId } }) : null
  const saleDate = businessDate(order.organization.timezone, check?.paidAt ?? order.closedAt ?? new Date())

  // One open draft per branch and day, even when two tills complete orders
  // at the same instant
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`orders-sale:${order.branchId}:${saleDate.toISOString()}`}))`

  let sale = await tx.dailySale.findFirst({
    where: { organizationId: order.organizationId, branchId: order.branchId, source: 'orders', status: 'draft', saleDate },
    orderBy: { createdAt: 'desc' },
  })
  if (!sale) {
    const saleNo = await nextNumber(tx as unknown as PrismaClient, 'dailySale', 'saleNo', order.branch.salePrefix || 'SL', order.organizationId)
    sale = await tx.dailySale.create({
      data: {
        organizationId: order.organizationId,
        branchId: order.branchId,
        saleNo,
        saleDate,
        source: 'orders',
        status: 'draft',
        subtotal: 0,
        totalAmount: 0,
        netAmount: 0,
        vatRate: order.branch.vatEnabled ? order.branch.vatRate : 0,
        createdBy: userId,
      },
    })
  }
  if (check) await tx.orderCheck.update({ where: { id: check.id }, data: { dailySaleId: sale.id } })
  else await tx.customerOrder.update({ where: { id: order.id }, data: { dailySaleId: sale.id } })
  return recomputeOrdersSale(tx, sale.id)
}

// Takes a completed order back out of its Daily Sale (refund). Only possible
// while that day is still a draft — after it is finalized the ledger entry
// stands and a refund has to be recorded in Daily Sales instead.
export async function removeOrderFromDailySale(tx: Tx, orderId: string) {
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } })
  if (!order.dailySaleId) return
  await tx.$queryRaw`SELECT id FROM "DailySale" WHERE id = ${order.dailySaleId} FOR UPDATE`
  const sale = await tx.dailySale.findUniqueOrThrow({ where: { id: order.dailySaleId } })
  if (sale.status !== 'draft') {
    throw new AppError(
      `Sales for ${sale.saleDate.toISOString().slice(0, 10)} are already finalized (${sale.saleNo}) — record the refund in Daily Sales instead`,
      400, 'SALE_FINALIZED',
    )
  }
  await tx.customerOrder.update({ where: { id: order.id }, data: { dailySaleId: null } })
  await recomputeOrdersSale(tx, sale.id)
}
