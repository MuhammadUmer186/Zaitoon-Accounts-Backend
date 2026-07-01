import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

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

  res.json(paginatedResponse(sales, total, page, limit))
})

// GET /sales/pending-approval
router.get('/pending-approval', async (req: Request, res: Response) => {
  const sales = await prisma.dailySale.findMany({
    where: { organizationId: req.user.organizationId, status: 'submitted' },
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } } },
  })
  res.json({ data: sales })
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

  res.status(201).json(sale)
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
  res.json(sale)
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

  res.json(updated)
})

// POST /sales/:id/submit
router.post('/:id/submit', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'draft') throw new AppError('Only draft sales can be submitted', 400, 'INVALID_STATUS')

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() },
  })
  res.json(updated)
})

// POST /sales/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  const sale = await prisma.dailySale.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { branch: true },
  })
  if (!sale) throw new AppError('Sale not found', 404, 'NOT_FOUND')
  if (sale.status !== 'submitted') throw new AppError('Only submitted sales can be approved', 400, 'INVALID_STATUS')

  // Find relevant accounts
  const [cashAccount, salesAccount, vatAccount] = await Promise.all([
    prisma.account.findFirst({ where: { organizationId: req.user.organizationId, code: '1000' } }),
    prisma.account.findFirst({ where: { organizationId: req.user.organizationId, code: '4000' } }),
    prisma.account.findFirst({ where: { organizationId: req.user.organizationId, code: '2100' } }),
  ])

  // Create journal entry for the sale
  const year = new Date().getFullYear()
  const jeCount = await prisma.journalEntry.count({
    where: { organizationId: req.user.organizationId, entryNo: { startsWith: `JE-${year}-` } },
  })
  const entryNo = `JE-${year}-${(jeCount + 1).toString().padStart(4, '0')}`

  const lines = []
  if (cashAccount) {
    lines.push({
      accountId: cashAccount.id,
      description: 'Cash from sales',
      debitAmount: sale.cashAmount,
      creditAmount: 0,
      lineOrder: 1,
    })
  }
  if (salesAccount) {
    lines.push({
      accountId: salesAccount.id,
      description: 'Sales revenue',
      debitAmount: 0,
      creditAmount: sale.subtotal,
      lineOrder: 2,
    })
  }
  if (vatAccount && sale.vatAmount > 0) {
    lines.push({
      accountId: vatAccount.id,
      description: 'VAT payable',
      debitAmount: 0,
      creditAmount: sale.vatAmount,
      lineOrder: 3,
    })
  }

  let journalEntryId: string | undefined

  if (lines.length > 0) {
    const je = await prisma.journalEntry.create({
      data: {
        organizationId: req.user.organizationId,
        branchId: sale.branchId,
        entryNo,
        entryDate: sale.saleDate,
        referenceType: 'daily_sale',
        referenceId: sale.id,
        description: `Daily Sales - ${sale.saleNo}`,
        status: 'posted',
        totalDebit: sale.cashAmount,
        totalCredit: sale.subtotal + sale.vatAmount,
        isBalanced: Math.abs(sale.cashAmount - (sale.subtotal + sale.vatAmount)) < 0.01,
        postedBy: req.user.id,
        postedAt: new Date(),
        createdBy: req.user.id,
        lines: { create: lines },
      },
    })
    journalEntryId = je.id
  }

  const updated = await prisma.dailySale.update({
    where: { id: req.params.id },
    data: {
      status: 'approved',
      approvedBy: req.user.id,
      approvedAt: new Date(),
      journalEntryId,
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
