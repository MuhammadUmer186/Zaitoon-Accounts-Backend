import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma } from '@prisma/client'
import { Request } from 'express'
import { AppError } from '../middleware/error'
import { getUserPermissions } from '../utils/permissions'
import { ProReport } from '../utils/proReport'
import { formatContextFor, formatDateTime } from '../utils/reportFormat'

export type Tx = Prisma.TransactionClient
export const round2 = (n: number) => regionalRoundMoney(n)
export interface PaymentPart { method: string; amount: number }

export async function lockCashier(tx: Tx, branchId: string, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`till:${branchId}:${userId}`}))`
}

export async function recordPayment(tx: Tx, req: Request, order: { id: string; organizationId: string; branchId: string }, payments: PaymentPart[], type: 'sale' | 'refund', reference = order.id, offline: { occurredAt?: Date; sessionId?: string | null; riderCustody?: boolean; checkId?: string } = {}) {
  await lockCashier(tx, order.branchId, req.user.id)
  if (offline.riderCustody && (type !== 'sale' || payments.some((p) => p.method !== 'cash'))) throw new AppError('Rider custody is only for cash-on-delivery collections', 400, 'INVALID_PAYMENT')
  const session = offline.riderCustody || offline.sessionId === null ? null : await tx.tillSession.findFirst({ where: { organizationId: order.organizationId, branchId: order.branchId, userId: req.user.id, status: 'open', ...(offline.sessionId && { id: offline.sessionId }) } })
  if (offline.sessionId && !session) throw new AppError('The original offline till is closed; review this recorded payment', 409, 'OFFLINE_TILL_CLOSED')
  if (session && offline.occurredAt && offline.occurredAt < session.openedAt) throw new AppError('Offline payment predates the till opening', 409, 'OFFLINE_TIME_CONFLICT')
  const org = await tx.organization.findUniqueOrThrow({ where: { id: order.organizationId }, select: { requireTillForCash: true } })
  if (!offline.riderCustody && org.requireTillForCash && payments.some((p) => p.method === 'cash' && p.amount > 0) && !session) throw new AppError('Open your till session at this branch before taking or refunding cash', 409, 'TILL_REQUIRED')
  for (const [i, p] of payments.entries()) await tx.tillPayment.create({ data: {
    organizationId: order.organizationId, branchId: order.branchId, userId: req.user.id, sessionId: session?.id,
    orderId: order.id, checkId: offline.checkId, referenceKey: `${type}:${reference}:${i}`, method: p.method, amount: round2(p.amount), type, ...(offline.occurredAt && { createdAt: offline.occurredAt }),
  } })
  return session?.id ?? null
}

export function orderPayments(order: { payments: unknown; paymentMethod: string | null; totalAmount: number }): PaymentPart[] {
  return Array.isArray(order.payments) ? order.payments as PaymentPart[] : [{ method: order.paymentMethod ?? 'cash', amount: order.totalAmount }]
}

export async function tillTotals(tx: Tx, sessionId: string) {
  const s = await tx.tillSession.findUniqueOrThrow({ where: { id: sessionId }, include: { payments: true, movements: true } })
  const cash = s.payments.filter((p) => p.method === 'cash').reduce((n, p) => n + (p.type === 'sale' ? p.amount : -p.amount), 0)
  const movement = s.movements.reduce((n, m) => n + (m.type === 'pay_in' ? m.amount : -m.amount), 0)
  // cash taken outside sales (gift cards sold, house accounts paid) at this till
  const receipts = await tx.customerReceipt.findMany({ where: { tillSessionId: s.id, method: 'cash' }, select: { type: true, amount: true } })
  const receiptCash = round2(receipts.reduce((n, r) => n + r.amount, 0))
  const methods = ['cash', 'card', 'mada', 'bank_transfer', 'other', 'gift_card', 'loyalty', 'house_account'].map((method) => ({
    method, sales: round2(s.payments.filter((p) => p.method === method && p.type === 'sale').reduce((n, p) => n + p.amount, 0)),
    refunds: round2(s.payments.filter((p) => p.method === method && p.type === 'refund').reduce((n, p) => n + p.amount, 0)),
  }))
  const ids = [...new Set(s.payments.filter((p) => p.type === 'sale' && !p.checkId).map((p) => p.orderId))]
  const orders = (await tx.customerOrder.findMany({ where: { id: { in: ids } }, select: { discountAmount: true, promotionAmount: true, vatAmount: true } })).map((o) => ({ ...o, discountAmount: o.discountAmount + o.promotionAmount }))
  const checks = await tx.orderCheck.findMany({ where: { id: { in: [...new Set(s.payments.filter((p) => p.type === 'sale' && p.checkId).map((p) => p.checkId!))] } }, select: { discountAmount: true, vatAmount: true } })
  const voids = await tx.customerOrderItem.count({ where: { status: 'cancelled', cancelledBy: s.userId, updatedAt: { gte: s.openedAt, ...(s.closedAt && { lte: s.closedAt }) }, order: { branchId: s.branchId, organizationId: s.organizationId } } })
  return { session: s, receiptCash, expectedCash: round2(s.openingFloat + cash + movement + receiptCash), methods, discounts: round2([...orders, ...checks].reduce((n, o) => n + o.discountAmount, 0)), tax: round2([...orders, ...checks].reduce((n, o) => n + o.vatAmount, 0)), voids }
}

export async function tillReport(tx: Tx, sessionId: string, zNumber?: number): Promise<ProReport> {
  const t = await tillTotals(tx, sessionId)
  const org = await tx.organization.findUniqueOrThrow({ where: { id: t.session.organizationId }, select: { name: true, currency: true } })
  const branch = await tx.branch.findUniqueOrThrow({ where: { id: t.session.branchId }, select: { name: true } })
  // times in the organization's zone and date style (Z reports are stored as printed)
  const ctx = await formatContextFor(t.session.organizationId)
  const cashier = await tx.user.findUnique({ where: { id: t.session.userId }, select: { firstName: true, lastName: true, email: true } })
  return {
    key: zNumber ? 'till-z' : 'till-x', eyebrow: zNumber ? `Z REPORT ${zNumber}` : 'X REPORT', headline: zNumber ? `Till close Z-${zNumber}` : 'Till session so far',
    orgName: org.name, currency: org.currency, scopeLabel: branch.name, periodLabel: `${formatDateTime(t.session.openedAt, ctx)} – ${t.session.closedAt ? formatDateTime(t.session.closedAt, ctx) : 'still open'}`, generatedAt: new Date().toISOString(),
    summaryLine: [`Cashier: ${cashier ? [cashier.firstName, cashier.lastName].filter(Boolean).join(' ') || cashier.email : 'unknown'}`, t.session.deviceName].filter(Boolean).join('  |  '),
    kpis: [{ label: 'Expected cash', value: t.expectedCash, format: 'money' }, { label: 'Discounts', value: t.discounts, format: 'money' }, { label: 'Tax', value: t.tax, format: 'money' }, { label: 'Voided items', value: t.voids, format: 'integer' }],
    sections: [
      { type: 'table', id: 'methods', title: 'Payments by method', columns: [{ key: 'method', label: 'Method' }, { key: 'sales', label: 'Sales', format: 'money' }, { key: 'refunds', label: 'Refunds', format: 'money' }], rows: t.methods },
      { type: 'table', id: 'cash', title: 'Cash reconciliation', columns: [{ key: 'label', label: 'Description' }, { key: 'amount', label: 'Amount', format: 'money' }], rows: [
        { label: 'Opening float', amount: t.session.openingFloat }, ...t.session.movements.map((m) => ({ label: `${m.type}: ${m.reason}`, amount: m.type === 'pay_in' ? m.amount : -m.amount })),
        ...(t.receiptCash ? [{ label: 'Gift cards sold / accounts paid in cash', amount: t.receiptCash }] : []),
        { label: 'Expected cash', amount: t.expectedCash }, ...(t.session.countedCash == null ? [] : [{ label: 'Counted cash', amount: t.session.countedCash }, { label: 'Difference', amount: t.session.difference }]),
      ] },
    ],
  }
}

export async function canManageTills(tx: Tx, req: Request) {
  return (await getUserPermissions(tx, req.user.id)).permissions.has('can_manage_tills')
}

export const blindSession = <T extends { status: string; expectedCash: number; difference: number; countedCash: number | null }>(s: T) => {
  if (s.status === 'closed') return s
  const { expectedCash: _e, difference: _d, countedCash: _c, ...visible } = s
  return visible
}
