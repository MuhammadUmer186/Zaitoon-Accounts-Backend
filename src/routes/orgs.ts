import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'

const router = Router()

router.use(authenticate)

const orgSettingsSchema = z.object({
  name: z.string().min(1).optional(),
  vatNumber: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  city: z.string().optional(),
  lowStockThreshold: z.number().min(0).nullable().optional(),
})

// GET /orgs/:orgId
router.get('/:orgId', async (req: Request, res: Response) => {
  const { orgId } = req.params
  if (orgId !== req.user.organizationId) {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  const org = await prisma.organization.findUnique({ where: { id: orgId } })
  if (!org) {
    res.status(404).json({ message: 'Organization not found', code: 'NOT_FOUND' })
    return
  }
  res.json(org)
})

// PUT /orgs/:orgId
router.put('/:orgId', async (req: Request, res: Response) => {
  const { orgId } = req.params
  if (orgId !== req.user.organizationId) {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  const body = orgSettingsSchema.parse(req.body)
  const updated = await prisma.organization.update({ where: { id: orgId }, data: body })
  res.json(updated)
})

// GET /orgs/:orgId/users
router.get('/:orgId/users', async (req: Request, res: Response) => {
  const { orgId } = req.params
  if (orgId !== req.user.organizationId) {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const search = req.query.search as string | undefined

  const where = {
    organizationId: orgId,
    ...(search && {
      OR: [
        { firstName: { contains: search, mode: 'insensitive' as const } },
        { lastName: { contains: search, mode: 'insensitive' as const } },
        { email: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        roles: { include: { role: true } },
      },
    }),
    prisma.user.count({ where }),
  ])

  res.json(paginatedResponse(users, total, page, limit))
})

// PUT /orgs/:orgId/users/:userId/status
router.put('/:orgId/users/:userId/status', async (req: Request, res: Response) => {
  const { orgId, userId } = req.params
  if (orgId !== req.user.organizationId) {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId: orgId },
  })
  if (!user) {
    res.status(404).json({ message: 'User not found', code: 'NOT_FOUND' })
    return
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { isActive: !user.isActive },
    select: { id: true, email: true, isActive: true },
  })

  res.json(updated)
})

// GET /orgs/:orgId/branches
router.get('/:orgId/branches', async (req: Request, res: Response) => {
  const { orgId } = req.params
  if (orgId !== req.user.organizationId) {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  const branches = await prisma.branch.findMany({
    where: { organizationId: orgId },
    orderBy: { name: 'asc' },
  })

  res.json({ data: branches })
})

export default router
