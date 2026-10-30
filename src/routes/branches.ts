import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

// Form fields arrive as strings: a blank optional field means "not set"
// (stored as null) and the tax rate may come as "16" rather than 16.
const optionalText = z.string().trim().optional().nullable().transform((v) => v || null)

const branchSchema = z.object({
  name: z.string().trim().min(1, 'Branch name is required'),
  code: z.string().trim().min(1, 'Branch code is required').transform((v) => v.toUpperCase()),
  city: optionalText,
  address: optionalText,
  phone: optionalText,
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid branch email or leave it empty')])
    .optional().nullable().transform((v) => v || null),
  managerUserId: optionalText,
  vatEnabled: z.boolean().optional(),
  vatRate: z.coerce.number({ error: 'Sales tax rate must be a number' }).min(0, 'Sales tax rate cannot be negative').max(100, 'Sales tax rate cannot exceed 100%').optional(),
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

// Single-branch mode: only one active branch
async function assertBranchSlot(organizationId: string, reactivatingId?: string) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { multiBranch: true } })
  if (org?.multiBranch !== false) return
  const active = await prisma.branch.count({ where: { organizationId, isActive: true, ...(reactivatingId && { id: { not: reactivatingId } }) } })
  if (active > 0) {
    throw new AppError('This restaurant is set to a single branch. Turn on multi-branch under Settings → Modules to add or activate another branch.', 400, 'SINGLE_BRANCH_MODE')
  }
}

async function assertCodeFree(organizationId: string, code: string, exceptId?: string) {
  const clash = await prisma.branch.findFirst({ where: { organizationId, code, ...(exceptId && { id: { not: exceptId } }) } })
  if (clash) throw new AppError(`Branch code "${code}" is already used by ${clash.name} — choose another code`, 409, 'DUPLICATE_ENTRY')
}

// POST /branches
router.post('/', requirePermission('can_create_branch'), async (req: Request, res: Response) => {
  const body = branchSchema.parse(req.body)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { country: true } })
  const defaults = (await import('../utils/regions')).regionFor(org.country)
  await assertCodeFree(req.user.organizationId, body.code)
  await assertBranchSlot(req.user.organizationId)
  const branch = await prisma.branch.create({
    data: { vatRate: defaults?.taxRate ?? 0, vatEnabled: (defaults?.taxRate ?? 0) > 0, ...body, organizationId: req.user.organizationId },
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
router.put('/:id', requirePermission('can_create_branch'), async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const body = updateSchema(branchSchema).parse(req.body)
  const branch = await prisma.branch.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (res.locals.singleBranch && branch.isActive && body.isActive === false) throw new AppError('The restaurant must stay active in single-branch mode. Enable multiple branches before deactivating it.', 400, 'SINGLE_BRANCH_MODE')
  if (body.code && body.code !== branch.code) await assertCodeFree(req.user.organizationId, body.code, id)
  if (body.isActive === true && !branch.isActive) await assertBranchSlot(req.user.organizationId, id)
  const updated = await prisma.branch.update({ where: { id }, data: body })
  res.json(updated)
})

// DELETE /branches/:id — hard-deletes if no transactions, otherwise 409
router.delete('/:id', requirePermission('can_create_branch'), async (req: Request, res: Response) => {
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
  if (res.locals.singleBranch && branch.isActive) throw new AppError('The restaurant cannot be deleted in single-branch mode.', 400, 'SINGLE_BRANCH_MODE')
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
