import { moneyUnit, moneyTolerance, roundMoney as regionalRoundMoney } from '../utils/money'
import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { assertNotOwnSubmission, requireModule, requirePermission } from '../middleware/authorize'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, resolveMappedAccount, reverseJournalEntry } from '../utils/ledger'
import { assertBranchAccess } from '../utils/branchScope'
import { riderCashAdjustment } from '../services/deliveryCash'
import { receiptCash } from '../services/customerReceipts'
import { formatContextFor, momentRange } from '../utils/reportFormat'

const router = Router()

router.use(authenticate)
router.use(requireModule('cash_closing', 'approvals'))

const closingSchema = z.object({
  branchId: z.string(),
  closingDate: z.string().or(z.date()),
  openingCash: z.number().min(0, 'Amounts cannot be negative').default(0),
  // ignored: cash sales always come from the day's recorded sales (see systemCashSales)
  cashSales: z.number().optional(),
  cashExpensesPaid: z.number().min(0, 'Amounts cannot be negative').default(0),
  cashDeposited: z.number().min(0, 'Amounts cannot be negative').default(0),
  otherCashIn: z.number().min(0, 'Amounts cannot be negative').default(0),
  otherCashOut: z.number().min(0, 'Amounts cannot be negative').default(0),
  actualCashCounted: z.number().min(0, 'Amounts cannot be negative').default(0),
  notes: z.string().optional(),
})

function computeExpected(data: {
  openingCash: number
  cashSales: number
  cashExpensesPaid: number
  cashDeposited: number
  otherCashIn: number
  otherCashOut: number
}) {
  return (
    data.openingCash +
    data.cashSales +
    data.otherCashIn -
    data.cashExpensesPaid -
    data.cashDeposited -
    data.otherCashOut
  )
}

// The closing day as Daily Sales stores it (midnight UTC of that date)
function closingDay(value: string | Date): Date {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new AppError('Invalid closing date', 400, 'VALIDATION_ERROR')
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

// Cash taken that day according to the system (manual Daily Sales plus
// POS / QR / online orders) — the cashier cannot type their own figure.
async function systemCashSales(organizationId: string, branchId: string, day: Date, db: PrismaClient | Prisma.TransactionClient = prisma): Promise<number> {
  const agg = await db.dailySale.aggregate({
    where: { organizationId, branchId, status: { not: 'void' }, saleDate: { gte: day, lt: new Date(day.getTime() + 86_400_000) } },
    _sum: { cashAmount: true },
  })
  const ctx = await formatContextFor(organizationId), date = day.toISOString().slice(0, 10)
  const range = momentRange(date, date, ctx)!
  // Refunded checks leave their draft sale, but physical cash still belongs
  // to the collection day and the refund goes out on its actual event day.
  const [refundedChecks, refunds] = await Promise.all([
    db.orderCheck.findMany({ where: { organizationId, branchId, status: 'refunded', paidAt: range }, select: { payments: true } }),
    db.tillPayment.aggregate({ where: { organizationId, branchId, checkId: { not: null }, type: 'refund', method: 'cash', createdAt: range }, _sum: { amount: true } }),
  ])
  const originalCash = refundedChecks.reduce((n, c) => n + (c.payments as { method: string; amount: number }[]).filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0), 0)
  // plus cash for gift cards sold and house accounts paid that day
  return regionalRoundMoney(((agg._sum.cashAmount ?? 0) + originalCash - (refunds._sum.amount ?? 0) + await riderCashAdjustment(organizationId, branchId, day, db) + await receiptCash(db, organizationId, branchId, day)))
}

// One live closing per branch and day
async function assertNoOtherClosing(organizationId: string, branchId: string, day: Date, exceptId?: string) {
  const other = await prisma.cashClosing.findFirst({
    where: { organizationId, branchId, status: { not: 'void' }, closingDate: { gte: day, lt: new Date(day.getTime() + 86_400_000) }, ...(exceptId && { id: { not: exceptId } }) },
    select: { closingNo: true },
  })
  if (other) throw new AppError(`${other.closingNo} already closes this branch for that day — edit or void it instead`, 409, 'DUPLICATE_CLOSING')
}

function getDifferenceType(diff: number): string {
  if (Math.abs(diff) < moneyUnit()) return 'balanced'
  return diff < 0 ? 'short' : 'excess'
}

// GET /cash-closing/pending-approval
router.get('/pending-approval', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'submitted' }
  if (branchId) where.branchId = branchId

  const closings = await prisma.cashClosing.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } } },
  })
  res.json({ data: closings })
})

// GET /cash-closing
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, fromDate, toDate, status } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (status) where.status = status
  if (fromDate || toDate) {
    where.closingDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [closings, total] = await Promise.all([
    prisma.cashClosing.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { closingDate: 'desc' },
      include: { branch: { select: { id: true, name: true, code: true } } },
    }),
    prisma.cashClosing.count({ where }),
  ])

  res.json(paginatedResponse(closings, total, page, limit))
})

// POST /cash-closing
router.post('/', requirePermission('can_create_cash_closing'), async (req: Request, res: Response) => {
  const body = closingSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, branch.id)
  const day = closingDay(body.closingDate)
  await assertNoOtherClosing(req.user.organizationId, branch.id, day)

  const closingNo = await nextNumber(prisma, 'cashClosing', 'closingNo', 'CC', req.user.organizationId)
  const cashSales = await systemCashSales(req.user.organizationId, branch.id, day)
  const expectedCash = computeExpected({ ...body, cashSales })
  const difference = body.actualCashCounted - expectedCash
  const differenceType = getDifferenceType(difference)

  const closing = await prisma.cashClosing.create({
    data: {
      ...body,
      cashSales,
      closingNo,
      closingDate: day,
      organizationId: req.user.organizationId,
      expectedCash,
      difference,
      differenceType,
      createdBy: req.user.id,
    },
    include: { branch: true },
  })

  res.status(201).json(closing)
})

// GET /cash-closing/:id
router.get('/:id', async (req: Request, res: Response) => {
  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { branch: true },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  res.json(closing)
})

// PUT /cash-closing/:id
router.put('/:id', requirePermission('can_create_cash_closing'), async (req: Request, res: Response) => {
  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (closing.status !== 'draft') throw new AppError('Only draft closings can be edited', 400, 'INVALID_STATUS')

  const body = updateSchema(closingSchema).parse(req.body)
  delete body.cashSales
  const day = body.closingDate ? closingDay(body.closingDate) : closing.closingDate
  await assertNoOtherClosing(req.user.organizationId, closing.branchId, day, closing.id)
  const cashSales = await systemCashSales(req.user.organizationId, closing.branchId, day)
  const mergedData = { ...closing, ...body }
  const expectedCash = computeExpected({
    openingCash: mergedData.openingCash,
    cashSales,
    cashExpensesPaid: mergedData.cashExpensesPaid,
    cashDeposited: mergedData.cashDeposited,
    otherCashIn: mergedData.otherCashIn,
    otherCashOut: mergedData.otherCashOut,
  })
  const difference = (mergedData.actualCashCounted ?? closing.actualCashCounted) - expectedCash
  const differenceType = getDifferenceType(difference)

  const updated = await prisma.cashClosing.update({
    where: { id: req.params.id },
    data: {
      ...body,
      ...(body.closingDate && { closingDate: day }),
      cashSales,
      expectedCash,
      difference,
      differenceType,
    },
    include: { branch: true },
  })

  res.json(updated)
})

// POST /cash-closing/:id/submit
router.post('/:id/submit', requirePermission('can_create_cash_closing'), async (req: Request, res: Response) => {
  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (closing.status !== 'draft') throw new AppError('Only draft closings can be submitted', 400, 'INVALID_STATUS')

  // sales recorded since the draft was saved count too
  const cashSales = await systemCashSales(req.user.organizationId, closing.branchId, closing.closingDate)
  const expectedCash = computeExpected({ ...closing, cashSales })
  const difference = closing.actualCashCounted - expectedCash
  const updated = await prisma.cashClosing.update({
    where: { id: req.params.id },
    data: { status: 'submitted', cashSales, expectedCash, difference, differenceType: getDifferenceType(difference) },
  })
  res.json(updated)
})

// POST /cash-closing/:id/approve — posts the cash over/short entry, if any.
// A perfectly balanced closing has nothing to post.
router.post('/:id/approve', requirePermission('can_approve_cash_closing'), async (req: Request, res: Response) => {
  const snapshot = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!snapshot) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (snapshot.status !== 'submitted') throw new AppError('Only submitted closings can be approved', 400, 'INVALID_STATUS')
  await assertBranchAccess(req, snapshot.branchId)
  await assertNotOwnSubmission(req, snapshot.createdBy, 'cash closing')

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-settlement:${snapshot.branchId}`}))`
    await tx.$queryRaw`SELECT id FROM "CashClosing" WHERE id = ${snapshot.id} FOR UPDATE`
    const closing = await tx.cashClosing.findUniqueOrThrow({ where: { id: snapshot.id } })
    if (closing.status !== 'submitted') throw new AppError('Only submitted closings can be approved', 400, 'INVALID_STATUS')
    if (Math.abs(await systemCashSales(req.user.organizationId, closing.branchId, closing.closingDate, tx) - closing.cashSales) > moneyTolerance()) throw new AppError('Cash receipts changed after submission; void and recount this closing', 409, 'CLOSING_CHANGED')
    let journalEntryId: string | undefined
    const diff = Math.abs(closing.difference)

    if (diff > moneyTolerance()) {
      const [cashOverShort, cash] = await Promise.all([
        resolveMappedAccount(tx as unknown as PrismaClient, req.user.organizationId, 'CASH_OVER_SHORT'),
        resolveMappedAccount(tx as unknown as PrismaClient, req.user.organizationId, 'CASH_ON_HAND'),
      ])

      const je = await postJournalEntry(tx as unknown as PrismaClient, {
        organizationId: req.user.organizationId,
        branchId: closing.branchId,
        entryDate: closing.closingDate,
        referenceType: 'cash_closing',
        referenceId: closing.id,
        sourceType: 'CASH_CLOSING',
        sourceKey: `CASH_CLOSING:${closing.id}:APPROVAL`,
        description: `Cash Closing ${closing.closingNo} — ${closing.differenceType}`,
        createdBy: req.user.id,
        lines: closing.differenceType === 'short'
          ? [
              { accountId: cashOverShort.id, description: 'Cash shortage', debitAmount: diff },
              { accountId: cash.id, description: 'Cash shortage', creditAmount: diff },
            ]
          : [
              { accountId: cash.id, description: 'Cash overage', debitAmount: diff },
              { accountId: cashOverShort.id, description: 'Cash overage', creditAmount: diff },
            ],
      })
      journalEntryId = je?.id
    }

    return tx.cashClosing.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), journalEntryId },
    })
  })
  res.json(updated)
})

// POST /cash-closing/:id/void
router.post('/:id/void', requirePermission('can_approve_cash_closing'), async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (closing.status === 'void') throw new AppError('Cash closing is already voided', 400, 'INVALID_STATUS')

  if (closing.journalEntryId) {
    await reverseJournalEntry(prisma, closing.journalEntryId, req.user.id, `Void — ${voidReason}`, req.user.organizationId)
  }

  const updated = await prisma.cashClosing.update({
    where: { id: req.params.id },
    data: { status: 'void' },
  })
  res.json(updated)
})

export default router
