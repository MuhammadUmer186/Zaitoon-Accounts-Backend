import { moneyTolerance as regionalMoneyTolerance } from '../utils/money'
import { Prisma, PrismaClient } from '@prisma/client'
import { Request } from 'express'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { formatContextFor, momentRange } from '../utils/reportFormat'
import { businessDate } from './orderSales'
import { lockCashier, round2 } from './tills'

export interface SettlementInput { requestId: string; riderId: string; collectionIds: string[]; countedCash: number; notes?: string }
export async function settleRiderCash(req: Request, input: SettlementInput) {
  const orgId = req.user.organizationId
  const rider = await prisma.rider.findFirst({ where: { id: input.riderId, organizationId: orgId } })
  if (!rider) throw new AppError('Rider not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, rider.branchId)
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-handover:${orgId}:${input.requestId}`}))`
    // Same rider lock is used when cash is collected or a refund is checked.
    await tx.$executeRaw`SELECT id FROM "Rider" WHERE id = ${rider.id} FOR UPDATE`
    const previous = await tx.riderSettlement.findUnique({ where: { organizationId_requestId: { organizationId: orgId, requestId: input.requestId } }, include: { collections: true } })
    if (previous) {
      if (previous.riderId !== rider.id || previous.userId !== req.user.id || previous.countedCash !== input.countedCash || previous.notes !== (input.notes || null) || previous.collections.map((c) => c.id).sort().join() !== [...input.collectionIds].sort().join()) throw new AppError('Settlement request ID was already used with different details', 409, 'SETTLEMENT_REQUEST_CONFLICT')
      return { settlement: previous, duplicate: true }
    }
    const collections = await tx.riderCashCollection.findMany({ where: { id: { in: input.collectionIds }, organizationId: orgId, riderId: rider.id, settlementId: null }, include: { payment: true } })
    if (collections.length !== input.collectionIds.length) throw new AppError('One or more collections were already settled or belong to another rider', 409, 'COLLECTION_CONFLICT')
    await lockCashier(tx, rider.branchId, req.user.id)
    const till = await tx.tillSession.findFirst({ where: { organizationId: orgId, branchId: rider.branchId, userId: req.user.id, status: 'open' } })
    if (!till) throw new AppError('Open your own till at this branch before receiving rider cash', 409, 'TILL_REQUIRED')
    if (collections.some((c) => c.payment.sessionId !== null || c.payment.type !== 'sale' || c.payment.method !== 'cash' || Math.abs(c.payment.amount - c.amount) > regionalMoneyTolerance())) throw new AppError('Collection payment needs review', 409, 'COLLECTION_CONFLICT')
    const expectedCash = round2(collections.reduce((n, c) => n + c.amount, 0)), difference = round2(input.countedCash - expectedCash)
    if (difference && (input.notes?.length ?? 0) < 3) throw new AppError('Explain the cash shortage or excess', 400, 'SETTLEMENT_REASON_REQUIRED')
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } })
    // Branch sequence cannot race between two riders handing in together.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-settlement:${rider.branchId}`}))`
    if (await tx.cashClosing.count({ where: { organizationId: orgId, branchId: rider.branchId, closingDate: businessDate(org.timezone), status: 'approved' } })) throw new AppError('Today’s cash closing is approved; reopen it before receiving more cash', 409, 'CASH_DAY_CLOSED')
    const last = await tx.riderSettlement.aggregate({ where: { branchId: rider.branchId }, _max: { number: true } })
    const settlement = await tx.riderSettlement.create({ data: { organizationId: orgId, branchId: rider.branchId, riderId: rider.id, userId: req.user.id, tillSessionId: till.id, requestId: input.requestId, number: (last._max.number ?? 0) + 1, businessDate: businessDate(org.timezone), expectedCash, countedCash: input.countedCash, difference, notes: input.notes || null } })
    await tx.riderCashCollection.updateMany({ where: { id: { in: input.collectionIds } }, data: { settlementId: settlement.id } })
    // Attach the original sale payment; never create another payment or pay-in.
    await tx.tillPayment.updateMany({ where: { id: { in: collections.map((c) => c.tillPaymentId) }, sessionId: null }, data: { sessionId: till.id } })
    await tx.customerOrder.updateMany({ where: { id: { in: collections.map((c) => c.orderId) } }, data: { tillSessionId: till.id } })
    await logAudit(tx, { req, action: 'rider_cash_settlement', module: 'delivery', branchId: rider.branchId, resourceId: settlement.id, newData: { ...input, expectedCash, difference, tillSessionId: till.id } })
    return { settlement, duplicate: false }
  })
}

// Sales stay on the customer's payment day; physical cash enters on handover.
// Refund events are immutable, so cross-day refunds do not rewrite handovers.
export async function riderCashAdjustment(organizationId: string, branchId: string, day: Date, db: PrismaClient | Prisma.TransactionClient = prisma) {
  const ctx = await formatContextFor(organizationId), date = day.toISOString().slice(0, 10)
  const range = momentRange(date, date, ctx)!
  const [collections, handed, refunds] = await Promise.all([
    db.riderCashCollection.aggregate({ where: { organizationId, branchId, businessDate: day, order: { status: 'completed' } }, _sum: { amount: true } }),
    db.riderSettlement.aggregate({ where: { organizationId, branchId, businessDate: day }, _sum: { expectedCash: true } }),
    db.$queryRaw<{ amount: number }[]>(Prisma.sql`SELECT COALESCE(SUM(p.amount), 0)::float AS amount FROM "TillPayment" p JOIN "RiderCashCollection" c ON c."orderId" = p."orderId" WHERE p."organizationId" = ${organizationId} AND p."branchId" = ${branchId} AND p.type = 'refund' AND p.method = 'cash' AND p."createdAt" >= ${range.gte!} AND p."createdAt" < ${range.lt!}`),
  ])
  return round2(-(collections._sum.amount ?? 0) + (handed._sum.expectedCash ?? 0) - (refunds[0]?.amount ?? 0))
}
