import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const expenseSchema = z.object({
  branchId: z.string(),
  expenseDate: z.string().or(z.date()),
  categoryId: z.string(),
  description: z.string().min(1),
  amount: z.number().positive(),
  vatAmount: z.number().default(0),
  vatRate: z.number().default(0),
  totalAmount: z.number(),
  paymentMethod: z.string().default('cash'),
  supplierId: z.string().optional(),
  notes: z.string().optional(),
})

const categorySchema = z.object({
  name: z.string().min(1),
  accountId: z.string().optional(),
  description: z.string().optional(),
})

// GET /expenses/categories
router.get('/categories', async (req: Request, res: Response) => {
  const categories = await prisma.expenseCategory.findMany({
    where: { organizationId: req.user.organizationId, isActive: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: categories })
})

// POST /expenses/categories
router.post('/categories', async (req: Request, res: Response) => {
  const body = categorySchema.parse(req.body)
  const category = await prisma.expenseCategory.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(category)
})

// DELETE /expenses/categories/:id
router.delete('/categories/:id', async (req: Request, res: Response) => {
  const inUse = await prisma.expense.count({
    where: { categoryId: req.params.id, organizationId: req.user.organizationId },
  })
  if (inUse > 0) throw new AppError(`Cannot delete — ${inUse} expense(s) use this category`, 400, 'IN_USE')

  await prisma.expenseCategory.delete({ where: { id: req.params.id } })
  res.json({ message: 'Category deleted' })
})

// GET /expenses
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, fromDate, toDate, status, categoryId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (status) where.status = status
  if (categoryId) where.categoryId = categoryId
  if (fromDate || toDate) {
    where.expenseDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { expenseDate: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        category: true,
      },
    }),
    prisma.expense.count({ where }),
  ])

  res.json(paginatedResponse(expenses, total, page, limit))
})

// POST /expenses
router.post('/', async (req: Request, res: Response) => {
  const body = expenseSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const expenseNo = await nextNumber(
    prisma,
    'expense',
    'expenseNo',
    branch.expensePrefix || 'EXP',
    req.user.organizationId
  )

  const expense = await prisma.expense.create({
    data: {
      ...body,
      expenseNo,
      expenseDate: new Date(body.expenseDate),
      organizationId: req.user.organizationId,
      createdBy: req.user.id,
    },
    include: { branch: true, category: true },
  })

  res.status(201).json(expense)
})

// GET /expenses/:id
router.get('/:id', async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { branch: true, category: true },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  res.json(expense)
})

// PUT /expenses/:id
router.put('/:id', async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be edited', 400, 'INVALID_STATUS')

  const body = expenseSchema.partial().parse(req.body)

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: {
      ...body,
      ...(body.expenseDate && { expenseDate: new Date(body.expenseDate) }),
    },
    include: { branch: true, category: true },
  })

  res.json(updated)
})

// POST /expenses/:id/submit
router.post('/:id/submit', async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be submitted', 400, 'INVALID_STATUS')

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() },
  })
  res.json(updated)
})

// POST /expenses/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  if (expense.status !== 'submitted') throw new AppError('Only submitted expenses can be approved', 400, 'INVALID_STATUS')

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
  })
  res.json(updated)
})

// DELETE /expenses/:id (draft only)
router.delete('/:id', async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be deleted', 400, 'INVALID_STATUS')

  await prisma.expense.delete({ where: { id: req.params.id } })
  res.json({ message: 'Expense deleted' })
})

// POST /expenses/:id/void
router.post('/:id/void', async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  res.json(updated)
})

export default router
