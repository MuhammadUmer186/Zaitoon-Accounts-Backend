import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const branchSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  city: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  managerUserId: z.string().optional(),
  vatEnabled: z.boolean().optional(),
  vatRate: z.number().optional(),
  invoicePrefix: z.string().optional(),
  salePrefix: z.string().optional(),
  expensePrefix: z.string().optional(),
  isActive: z.boolean().optional(),
})

// GET /branches
router.get('/', async (req: Request, res: Response) => {
  const branches = await prisma.branch.findMany({
    where: { organizationId: req.user.organizationId },
    orderBy: { name: 'asc' },
  })
  res.json({ data: branches })
})

// POST /branches
router.post('/', async (req: Request, res: Response) => {
  const body = branchSchema.parse(req.body)
  const branch = await prisma.branch.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(branch)
})

// GET /branches/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const branch = await prisma.branch.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  res.json(branch)
})

// PUT /branches/:id
router.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const body = branchSchema.partial().parse(req.body)
  const branch = await prisma.branch.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  const updated = await prisma.branch.update({ where: { id }, data: body })
  res.json(updated)
})

// DELETE /branches/:id — hard-deletes if no transactions, otherwise 409
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string

  const branch = await prisma.branch.findFirst({
    where: { id, organizationId: req.user.organizationId },
    include: {
      _count: {
        select: {
          dailySales: true,
          cashClosings: true,
          expenses: true,
          bills: true,
          stockMovements: true,
          wastageReports: true,
          journalEntries: true,
        },
      },
    },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const totalRecords = Object.values(branch._count).reduce((sum, n) => sum + n, 0)
  if (totalRecords > 0) {
    throw new AppError(
      'Cannot delete a branch that has existing transactions. Deactivate it instead.',
      409,
      'HAS_DATA',
    )
  }

  await prisma.userBranchAccess.deleteMany({ where: { branchId: id } })
  await prisma.branch.delete({ where: { id } })
  res.json({ message: 'Branch deleted' })
})

export default router
