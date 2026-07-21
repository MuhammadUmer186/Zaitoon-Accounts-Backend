import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, GL } from '../utils/ledger'

const router = Router()

router.use(authenticate)

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
      orderBy: { saleDate: 'desc' },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        deliveryBreakdown: true,
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
router.post('/', async (req: Request, res: Response) => {
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

// GET /sales/:id
router.get('/:id', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: {
      branch: true,
      deliveryBreakdown: true,
    },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  res.json(withBranchName(sale))
})

// PUT /sales/:id
router.put('/:id', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'draft') throw new AppError('Only draft sales can be edited', 400, 'INVALID_STATUS')

  const body = saleSchema.partial().parse(req.body)
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
// where that money actually sits; revenue is recognized as the plug so
// the entry always balances regardless of discount/refund composition.
// Shared by /submit (the normal path — daily sales need no approval) and
// /approve (kept only to resolve any pre-existing 'submitted' records).
async function postSaleJournalEntry(sale: {
  id: string; saleNo: string; branchId: string; saleDate: Date
  cashAmount: number; cardAmount: number; deliveryAmount: number; bankTransferAmount: number; otherAmount: number
  vatAmount: number
}, organizationId: string, userId: string) {
  const totalReceived = sale.cashAmount + sale.cardAmount + sale.deliveryAmount + sale.bankTransferAmount + sale.otherAmount

  return postJournalEntry(prisma, {
    organizationId,
    branchId: sale.branchId,
    entryDate: sale.saleDate,
    referenceType: 'daily_sale',
    referenceId: sale.id,
    description: `Daily Sales - ${sale.saleNo}`,
    createdBy: userId,
    lines: [
      { accountCode: GL.CASH, description: 'Cash received', debitAmount: sale.cashAmount },
      { accountCode: GL.CARD_CLEARING, description: 'Card receipts', debitAmount: sale.cardAmount },
      { accountCode: GL.DELIVERY_CLEARING, description: 'Delivery platform receipts', debitAmount: sale.deliveryAmount },
      { accountCode: GL.BANK, description: 'Bank transfer receipts', debitAmount: sale.bankTransferAmount },
      { accountCode: GL.CASH, description: 'Other receipts', debitAmount: sale.otherAmount },
      { accountCode: GL.VAT_PAYABLE, description: 'VAT payable', creditAmount: sale.vatAmount },
      { accountCode: GL.SALES_REVENUE, description: 'Sales revenue', creditAmount: totalReceived - sale.vatAmount },
    ],
  })
}

// POST /sales/:id/submit — daily sales need no separate approval step
// (unlike purchases): submitting a draft finalizes it immediately, posting
// the journal entry straight away.
router.post('/:id/submit', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'draft') throw new AppError('Only draft sales can be submitted', 400, 'INVALID_STATUS')

  const je = await postSaleJournalEntry(sale, req.user.organizationId, req.user.id)
  const now = new Date()

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: {
      status: 'approved',
      submittedBy: req.user.id,
      submittedAt: now,
      approvedBy: req.user.id,
      approvedAt: now,
      journalEntryId: je?.id,
    },
  })
  res.json(updated)
})

// POST /sales/:id/approve — kept only to resolve any sale that was already
// sitting in 'submitted' status before daily sales stopped requiring
// approval; new sales never reach this via /submit anymore.
router.post('/:id/approve', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'submitted') throw new AppError('Only submitted sales can be approved', 400, 'INVALID_STATUS')

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
router.post('/:id/void', async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status === 'void') throw new AppError('Sale is already voided', 400, 'INVALID_STATUS')

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  res.json(updated)
})

export default router
