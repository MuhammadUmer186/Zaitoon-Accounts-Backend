import { roundMoney } from '../utils/money'
import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { assertNotOwnSubmission, requireModule, requirePermission } from '../middleware/authorize'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, resolveMappedAccount, reverseJournalEntry } from '../utils/ledger'

const router = Router()

router.use(authenticate)
router.use(requireModule('sales', 'cash_closing', 'approvals'))

// The frontend reads a flat `branchName` field; Prisma's `include` only gives
// a nested `branch` object, so every sale response is flattened through this.
function withBranchName<T extends { branch?: { name: string } | null }>(sale: T): T & { branchName?: string } {
  return { ...sale, branchName: sale.branch?.name }
}

const deliveryBreakdownSchema = z.object({
  platform: z.string(),
  amount: z.number(),
  commission: z.number().default(0),
  netAmount: z.number(),
})

const saleSchema = z.object({
  branchId: z.string(),
  saleDate: z.string().or(z.date()),
  cashAmount: z.number().default(0),
  cardAmount: z.number().default(0),
  deliveryAmount: z.number().default(0),
  bankTransferAmount: z.number().default(0),
  otherAmount: z.number().default(0),
  subtotal: z.number(),
  discountAmount: z.number().default(0),
  vatAmount: z.number().default(0),
  totalAmount: z.number(),
  refundAmount: z.number().default(0),
  netAmount: z.number(),
  vatRate: z.number().default(15),
  notes: z.string().optional(),
  deliveryBreakdown: z.array(deliveryBreakdownSchema).optional(),
})

// GET /sales
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, fromDate, toDate, status } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (status) where.status = status
  if (fromDate || toDate) {
    where.saleDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [sales, total] = await Promise.all([
    prisma.dailySale.findMany({
      where,
      ...paginate(page, limit),
      orderBy: [{ saleDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        branch: { select: { id: true, name: true, code: true } },
        deliveryBreakdown: true,
        _count: { select: { orders: true } },
      },
    }),
    prisma.dailySale.count({ where }),
  ])

  res.json(paginatedResponse(sales.map(withBranchName), total, page, limit))
})

// GET /sales/pending-approval
router.get('/pending-approval', async (req: Request, res: Response) => {
  const sales = await prisma.dailySale.findMany({
    where: { organizationId: req.user.organizationId, status: 'submitted' },
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } } },
  })
  res.json({ data: sales.map(withBranchName) })
})

// GET /sales/summary
router.get('/summary', async (req: Request, res: Response) => {
  const { branchId } = req.query as { branchId?: string }
  const orgId = req.user.organizationId

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 59, 999)

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

  const baseWhere = {
    organizationId: orgId,
    ...(branchId && { branchId }),
    status: { not: 'void' },
  }

  const [todaySales, monthSales, countByStatus] = await Promise.all([
    prisma.dailySale.aggregate({
      where: { ...baseWhere, saleDate: { gte: today, lte: endOfToday } },
      _sum: { netAmount: true },
      _count: true,
    }),
    prisma.dailySale.aggregate({
      where: { ...baseWhere, saleDate: { gte: startOfMonth } },
      _sum: { netAmount: true },
      _count: true,
    }),
    prisma.dailySale.groupBy({
      by: ['status'],
      where: { organizationId: orgId, ...(branchId && { branchId }) },
      _count: true,
    }),
  ])

  res.json({
    todayTotal: todaySales._sum.netAmount || 0,
    todayCount: todaySales._count,
    monthTotal: monthSales._sum.netAmount || 0,
    monthCount: monthSales._count,
    statusBreakdown: countByStatus,
  })
})

// POST /sales
router.post('/', requirePermission('can_create_sales'), async (req: Request, res: Response) => {
  const body = saleSchema.parse(req.body)

  // Verify branch belongs to org
  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const saleNo = await nextNumber(prisma, 'dailySale', 'saleNo', branch.salePrefix || 'SL', req.user.organizationId)

  const { deliveryBreakdown, ...saleData } = body

  const sale = await prisma.dailySale.create({
    data: {
      ...saleData,
      saleNo,
      saleDate: new Date(saleData.saleDate),
      organizationId: req.user.organizationId,
      createdBy: req.user.id,
      deliveryBreakdown: deliveryBreakdown && deliveryBreakdown.length > 0
        ? { create: deliveryBreakdown }
        : undefined,
    },
    include: { deliveryBreakdown: true, branch: true },
  })

  res.status(201).json(withBranchName(sale))
})

// GET /sales/day-totals?branchId=&date=YYYY-MM-DD — what was taken that day
// (all non-void sales, manual and from orders), e.g. to pre-fill cash closing
router.get('/day-totals', async (req: Request, res: Response) => {
  const { branchId, date } = req.query as Record<string, string>
  if (!branchId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new AppError('branchId and date are required', 400, 'VALIDATION_ERROR')
  const day = new Date(`${date}T00:00:00.000Z`)
  const agg = await prisma.dailySale.aggregate({
    where: {
      organizationId: req.user.organizationId, branchId, status: { not: 'void' },
      saleDate: { gte: day, lt: new Date(day.getTime() + 86_400_000) },
    },
    _sum: { cashAmount: true, cardAmount: true, bankTransferAmount: true, otherAmount: true, deliveryAmount: true, netAmount: true },
    _count: true,
  })
  res.json({
    cash: agg._sum.cashAmount ?? 0,
    card: agg._sum.cardAmount ?? 0,
    bankTransfer: agg._sum.bankTransferAmount ?? 0,
    other: agg._sum.otherAmount ?? 0,
    delivery: agg._sum.deliveryAmount ?? 0,
    net: agg._sum.netAmount ?? 0,
    sales: agg._count,
  })
})

// GET /sales/:id
router.get('/:id', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: {
      branch: true,
      deliveryBreakdown: true,
      orders: {
        where: { status: 'completed' },
        orderBy: { closedAt: 'asc' },
        select: {
          id: true, orderNo: true, orderType: true, source: true, customerName: true, paymentMethod: true,
          itemsTotal: true, discountAmount: true, totalAmount: true, closedAt: true, table: { select: { name: true } },
        },
      },
    },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  res.json(withBranchName(sale))
})

// PUT /sales/:id
router.put('/:id', requirePermission('can_create_sales'), async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'draft') throw new AppError('Only draft sales can be edited', 400, 'INVALID_STATUS')
  if (sale.source === 'orders') {
    // amounts come from the linked orders — only the note can be changed
    const { notes } = z.object({ notes: z.string().max(1000).optional() }).parse(req.body)
    const updated = await prisma.dailySale.update({ where: { id: sale.id }, data: { notes }, include: { deliveryBreakdown: true, branch: true } })
    res.json(withBranchName(updated))
    return
  }

  const body = updateSchema(saleSchema).parse(req.body)
  const { deliveryBreakdown, ...saleData } = body

  if (deliveryBreakdown !== undefined) {
    await prisma.deliveryBreakdown.deleteMany({ where: { dailySaleId: req.params.id } })
    if (deliveryBreakdown.length > 0) {
      await prisma.deliveryBreakdown.createMany({
        data: deliveryBreakdown.map((d) => ({ ...d, dailySaleId: req.params.id })),
      })
    }
  }

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: {
      ...saleData,
      ...(saleData.saleDate && { saleDate: new Date(saleData.saleDate) }),
    },
    include: { deliveryBreakdown: true, branch: true },
  })

  res.json(withBranchName(updated))
})

// Standardized double-entry posting: every payment method is debited to
// where that money actually sits (resolved through Account Mappings, never
// silently created); revenue is recognized as the plug so the entry always
// balances regardless of discount/refund composition. Shared by /submit (the
// normal path — daily sales need no approval) and /approve (kept only to
// resolve any pre-existing 'submitted' records). Idempotent via sourceKey —
// retrying either endpoint never double-posts.
async function postSaleJournalEntry(sale: {
  id: string; saleNo: string; branchId: string; saleDate: Date
  cashAmount: number; cardAmount: number; deliveryAmount: number; bankTransferAmount: number; otherAmount: number
  giftCardAmount?: number; loyaltyAmount?: number; houseAccountAmount?: number
  vatAmount: number
}, organizationId: string, userId: string, db = prisma) {
  const giftCard = sale.giftCardAmount ?? 0, loyalty = sale.loyaltyAmount ?? 0, house = sale.houseAccountAmount ?? 0
  const totalReceived = sale.cashAmount + sale.cardAmount + sale.deliveryAmount + sale.bankTransferAmount + sale.otherAmount + giftCard + loyalty + house
  const cashLeg = sale.cashAmount + sale.otherAmount

  // gift cards and points spent settle a liability; house accounts are owed
  const [giftCardLiability, loyaltyLiability] = await Promise.all([
    giftCard > 0 ? resolveMappedAccount(db, organizationId, 'GIFT_CARD_LIABILITY') : null,
    loyalty > 0 ? resolveMappedAccount(db, organizationId, 'LOYALTY_LIABILITY') : null,
  ])
  const [cash, card, receivable, bank, outputVat, revenue] = await Promise.all([
    cashLeg > 0 ? resolveMappedAccount(db, organizationId, 'CASH_ON_HAND') : null,
    sale.cardAmount > 0 ? resolveMappedAccount(db, organizationId, 'CARD_CLEARING') : null,
    sale.deliveryAmount + house > 0 ? resolveMappedAccount(db, organizationId, 'ACCOUNTS_RECEIVABLE') : null,
    sale.bankTransferAmount > 0 ? resolveMappedAccount(db, organizationId, 'DEFAULT_BANK') : null,
    sale.vatAmount > 0 ? resolveMappedAccount(db, organizationId, 'OUTPUT_VAT') : null,
    resolveMappedAccount(db, organizationId, 'SALES_REVENUE'),
  ])

  return postJournalEntry(db, {
    organizationId,
    branchId: sale.branchId,
    entryDate: sale.saleDate,
    referenceType: 'daily_sale',
    referenceId: sale.id,
    sourceType: 'DAILY_SALE',
    sourceKey: `DAILY_SALE:${sale.id}:APPROVAL`,
    description: `Daily Sales - ${sale.saleNo}`,
    createdBy: userId,
    lines: [
      ...(cash ? [{ accountId: cash.id, description: 'Cash received', debitAmount: cashLeg }] : []),
      ...(card ? [{ accountId: card.id, description: 'Card receipts', debitAmount: sale.cardAmount }] : []),
      ...(receivable && sale.deliveryAmount > 0 ? [{ accountId: receivable.id, description: 'Delivery platform receipts', debitAmount: sale.deliveryAmount }] : []),
      ...(receivable && house > 0 ? [{ accountId: receivable.id, description: 'Customer house accounts', debitAmount: house }] : []),
      ...(giftCardLiability ? [{ accountId: giftCardLiability.id, description: 'Paid with gift cards', debitAmount: giftCard }] : []),
      ...(loyaltyLiability ? [{ accountId: loyaltyLiability.id, description: 'Paid with loyalty points', debitAmount: loyalty }] : []),
      ...(bank ? [{ accountId: bank.id, description: 'Bank transfer receipts', debitAmount: sale.bankTransferAmount }] : []),
      ...(outputVat ? [{ accountId: outputVat.id, description: 'Output VAT', creditAmount: sale.vatAmount }] : []),
      { accountId: revenue.id, description: 'Sales revenue', creditAmount: totalReceived - sale.vatAmount },
    ],
  })
}

// Points earned on a finalized "orders" day: part of the price belongs to
// the points the customers will spend later, so it moves from revenue to the
// loyalty liability (net of points taken back by same-day refunds).
async function postLoyaltyDeferral(sale: { id: string; saleNo: string; branchId: string; saleDate: Date }, organizationId: string, userId: string, db = prisma) {
  const orders = await db.customerOrder.findMany({ where: { dailySaleId: sale.id, status: 'completed' }, select: { id: true } })
  if (!orders.length) return null
  const agg = await db.loyaltyTransaction.aggregate({ where: { organizationId, orderId: { in: orders.map((o) => o.id) }, type: { in: ['earn', 'reverse_earn'] } }, _sum: { value: true } })
  const amount = roundMoney(agg._sum.value ?? 0)
  if (amount <= 0) return null
  const [revenue, liability] = await Promise.all([
    resolveMappedAccount(db, organizationId, 'SALES_REVENUE'),
    resolveMappedAccount(db, organizationId, 'LOYALTY_LIABILITY'),
  ])
  return postJournalEntry(db, {
    organizationId, branchId: sale.branchId, entryDate: sale.saleDate,
    referenceType: 'daily_sale', referenceId: sale.id, sourceType: 'DAILY_SALE_LOYALTY', sourceKey: `DAILY_SALE:${sale.id}:LOYALTY`,
    description: `Loyalty points earned - ${sale.saleNo}`, createdBy: userId,
    lines: [
      { accountId: revenue.id, description: 'Revenue deferred to points earned', debitAmount: amount },
      { accountId: liability.id, description: 'Loyalty points earned', creditAmount: amount },
    ],
  })
}

// Recipe-mode cost of sales for a finalized "orders" day: the ingredients the
// day's orders took out of stock (orders paid in "issues" mode took nothing,
// their cost was booked when stock was issued to the kitchen).
async function postOrdersCostOfSales(sale: { id: string; saleNo: string; branchId: string; saleDate: Date }, organizationId: string, userId: string, db = prisma) {
  const agg = await db.customerOrder.aggregate({
    where: { dailySaleId: sale.id, status: 'completed', stockDeductedAt: { not: null } },
    _sum: { foodCost: true },
  })
  const amount = roundMoney(agg._sum.foodCost ?? 0)
  if (amount <= 0) return null
  const [cogs, inventory] = await Promise.all([
    resolveMappedAccount(db, organizationId, 'COST_OF_SALES'),
    resolveMappedAccount(db, organizationId, 'INVENTORY'),
  ])
  return postJournalEntry(db, {
    organizationId,
    branchId: sale.branchId,
    entryDate: sale.saleDate,
    referenceType: 'daily_sale',
    referenceId: sale.id,
    sourceType: 'DAILY_SALE_COGS',
    sourceKey: `DAILY_SALE:${sale.id}:COGS`,
    description: `Cost of sales (recipes) - ${sale.saleNo}`,
    createdBy: userId,
    lines: [
      { accountId: cogs.id, description: 'Recipe cost of dishes sold', debitAmount: amount },
      { accountId: inventory.id, description: 'Ingredients used', creditAmount: amount },
    ],
  })
}

// POST /sales/:id/submit — daily sales need no separate approval step
// (unlike purchases): submitting a draft finalizes it immediately, posting
// the journal entry straight away.
router.post('/:id/submit', requirePermission('can_create_sales'), async (req: Request, res: Response) => {
  const updated = await prisma.$transaction(async (tx) => {
    const initial = await tx.dailySale.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
    if (!initial) throw new AppError('Sale not found', 404, 'NOT_FOUND')
    // Same lock as incoming paid orders; no receipt can change a day while
    // its revenue and cost journals are being finalized.
    if (initial.source === 'orders') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`orders-sale:${initial.branchId}:${initial.saleDate.toISOString()}`}))`
    await tx.$queryRaw`SELECT id FROM "DailySale" WHERE id = ${initial.id} FOR UPDATE`
    const sale = await tx.dailySale.findUniqueOrThrow({ where: { id: initial.id } })
    if (sale.status !== 'draft') throw new AppError('Only draft sales can be submitted', 400, 'INVALID_STATUS')
    const db = tx as unknown as typeof prisma
    const je = await postSaleJournalEntry(sale, req.user.organizationId, req.user.id, db)
    const cogs = sale.source === 'orders' ? await postOrdersCostOfSales(sale, req.user.organizationId, req.user.id, db) : null
    if (sale.source === 'orders') await postLoyaltyDeferral(sale, req.user.organizationId, req.user.id, db)
    const now = new Date()
    return tx.dailySale.update({ where: { id: sale.id }, data: {
      status: 'approved', submittedBy: req.user.id, submittedAt: now,
      approvedBy: req.user.id, approvedAt: now, journalEntryId: je?.id,
      ...(cogs && { cogsJournalEntryId: cogs.id }),
    } })
  })
  res.json(updated)
})

// POST /sales/:id/approve — kept only to resolve any sale that was already
// sitting in 'submitted' status before daily sales stopped requiring
// approval; new sales never reach this via /submit anymore.
router.post('/:id/approve', requirePermission('can_approve_sales'), async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'submitted') throw new AppError('Only submitted sales can be approved', 400, 'INVALID_STATUS')
  // automatic order days are built by the system, not keyed in by a person
  if (sale.source !== 'orders') await assertNotOwnSubmission(req, sale.createdBy, 'sale')

  const je = await postSaleJournalEntry(sale, req.user.organizationId, req.user.id)

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: {
      status: 'approved',
      approvedBy: req.user.id,
      approvedAt: new Date(),
      journalEntryId: je?.id,
    },
  })

  res.json(updated)
})

// POST /sales/:id/void
router.post('/:id/void', requirePermission('can_void_sales'), async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status === 'void') throw new AppError('Sale is already voided', 400, 'INVALID_STATUS')
  if (sale.source === 'orders') {
    throw new AppError('This sale is built from paid orders — refund the individual orders (while the day is open) instead of voiding it', 400, 'ORDERS_SALE')
  }

  if (sale.journalEntryId) {
    await reverseJournalEntry(prisma, sale.journalEntryId, req.user.id, `Void — ${voidReason}`)
  }

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  res.json(updated)
})

export default router
