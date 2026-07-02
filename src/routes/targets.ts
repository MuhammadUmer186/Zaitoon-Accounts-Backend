import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const upsertTargetSchema = z.object({
  branchId: z.string(),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  salesTarget: z.number().min(0),
})

// GET /targets?year=&month=
router.get('/', async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const now = new Date()
  const year = req.query.year ? parseInt(req.query.year as string) : now.getFullYear()
  const month = req.query.month ? parseInt(req.query.month as string) : now.getMonth() + 1

  const targets = await prisma.branchTarget.findMany({
    where: { organizationId: orgId, year, month },
    include: { branch: { select: { id: true, name: true, isActive: true } } },
  })

  res.json({ data: targets, year, month })
})

// PUT /targets — upsert a branch's target for a given year/month
router.put('/', async (req: Request, res: Response) => {
  const body = upsertTargetSchema.parse(req.body)
  const orgId = req.user.organizationId

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: orgId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const target = await prisma.branchTarget.upsert({
    where: { branchId_year_month: { branchId: body.branchId, year: body.year, month: body.month } },
    update: { salesTarget: body.salesTarget },
    create: {
      organizationId: orgId,
      branchId: body.branchId,
      year: body.year,
      month: body.month,
      salesTarget: body.salesTarget,
    },
    include: { branch: { select: { id: true, name: true } } },
  })

  res.json(target)
})

export default router
