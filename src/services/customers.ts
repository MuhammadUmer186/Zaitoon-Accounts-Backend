import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma } from '@prisma/client'
import { normalizePhone } from './deliveryPricing'

type Tx = Prisma.TransactionClient
const round2 = (n: number) => regionalRoundMoney(n)

// The customer for this phone number in the organization, created on first
// contact. One record per normalized phone, shared by POS, online and the
// call centre (the advisory lock keeps two first orders from racing).
export async function customerForPhone(tx: Tx, organizationId: string, phone: string, name?: string | null) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { country: true } })
  const normalized = normalizePhone(phone, org.country)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:${organizationId}:${normalized}`}))`
  const existing = await tx.customer.findUnique({ where: { organizationId_phone: { organizationId, phone: normalized } } })
  if (existing) return existing
  return tx.customer.create({ data: { organizationId, phone: normalized, name: name?.trim() || 'Guest' } })
}

// A completed order counts as one visit and its total as spend; a refund
// takes both back. Called once per order completion / refund.
export async function recordVisit(tx: Tx, order: { customerId: string | null; totalAmount: number; closedAt: Date | null }) {
  if (!order.customerId) return
  await tx.customer.update({ where: { id: order.customerId }, data: { visitCount: { increment: 1 }, totalSpend: { increment: round2(order.totalAmount) }, lastVisitAt: order.closedAt ?? new Date() } })
}
export async function reverseVisit(tx: Tx, order: { customerId: string | null; totalAmount: number }) {
  if (!order.customerId) return
  await tx.customer.update({ where: { id: order.customerId }, data: { visitCount: { decrement: 1 }, totalSpend: { decrement: round2(order.totalAmount) } } })
}

// a phone number on an order links its customer (best effort: an unusable
// number never blocks the order)
export async function linkCustomer(tx: Tx, organizationId: string, phone?: string | null, name?: string | null) {
  if (!phone || phone.replace(/\D/g, '').length < 7) return null
  try { return (await customerForPhone(tx, organizationId, phone, name)).id } catch { return null }
}
