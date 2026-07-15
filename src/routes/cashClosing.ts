import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const closingSchema = z.object({
  branchId: z.string(),
  closingDate: z.string().or(z.date()),
  openingCash: z.number().default(0),
  cashSales: z.number().default(0),
  cashExpensesPaid: z.number().default(0),
  cashDeposited: z.number().default(0),
  otherCashIn: z.number().default(0),
  otherCashOut: z.number().default(0),
  actualCashCounted: z.number().default(0),
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

function getDifferenceType(diff: number): string {
  if (Math.abs(diff) < 0.01) return 'balanced'
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
router.post('/', async (req: Request, res: Response) => {
  const body = closingSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const closingNo = await nextNumber(prisma, 'cashClosing', 'closingNo', 'CC', req.user.organizationId)
  const expectedCash = computeExpected(body)
  const difference = body.actualCashCounted - expectedCash
  const differenceType = getDifferenceType(difference)

  const closing = await prisma.cashClosing.create({
    data: {
      ...body,
      closingNo,
      closingDate: new Date(body.closingDate),
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
router.put('/:id', async (req: Request, res: Response) => {
  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (closing.status !== 'draft') throw new AppError('Only draft closings can be edited', 400, 'INVALID_STATUS')

  const body = closingSchema.partial().parse(req.body)
  const mergedData = { ...closing, ...body }
  const expectedCash = computeExpected({
    openingCash: mergedData.openingCash,
    cashSales: mergedData.cashSales,
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
      ...(body.closingDate && { closingDate: new Date(body.closingDate) }),
      expectedCash,
      difference,
      differenceType,
    },
    include: { branch: true },
  })

  res.json(updated)
})

// POST /cash-closing/:id/submit
router.post('/:id/submit', async (req: Request, res: Response) => {
  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (closing.status !== 'draft') throw new AppError('Only draft closings can be submitted', 400, 'INVALID_STATUS')

  const updated = await prisma.cashClosing.update({
    where: { id: req.params.id },
    data: { status: 'submitted' },
  })
  res.json(updated)
})

// POST /cash-closing/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')
  if (closing.status !== 'submitted') throw new AppError('Only submitted closings can be approved', 400, 'INVALID_STATUS')

  const updated = await prisma.cashClosing.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
  })
  res.json(updated)
})

// POST /cash-closing/:id/void
router.post('/:id/void', async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const closing = await prisma.cashClosing.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!closing) throw new AppError('Cash closing not found', 404, 'NOT_FOUND')

  const updated = await prisma.cashClosing.update({
    where: { id: req.params.id },
    data: { status: 'void' },
  })
  res.json(updated)
})

export default router
