import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma, config } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const createUserSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  password: z.string().min(8).default('Change@123'),
  roleIds: z.array(z.string()).optional(),
  branchIds: z.array(z.string()).optional(),
})

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string().min(8).optional(),
  isActive: z.boolean().optional(),
  roleIds: z.array(z.string()).optional(),
  branchIds: z.array(z.string()).optional(),
})

// GET /users
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const search = req.query.search as string | undefined

  const where = {
    organizationId: req.user.organizationId,
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
        avatarUrl: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        roles: { include: { role: true } },
        branchAccess: { include: { branch: true } },
      },
    }),
    prisma.user.count({ where }),
  ])

  res.json(paginatedResponse(users, total, page, limit))
})

// POST /users
router.post('/', async (req: Request, res: Response) => {
  const body = createUserSchema.parse(req.body)
  const passwordHash = await bcrypt.hash(body.password, config.bcryptRounds)

  const user = await prisma.user.create({
    data: {
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
      passwordHash,
      organizationId: req.user.organizationId,
    },
  })

  if (body.roleIds && body.roleIds.length > 0) {
    await prisma.userRole.createMany({
      data: body.roleIds.map((roleId) => ({ userId: user.id, roleId })),
      skipDuplicates: true,
    })
  }

  if (body.branchIds && body.branchIds.length > 0) {
    await prisma.userBranchAccess.createMany({
      data: body.branchIds.map((branchId) => ({
        userId: user.id,
        organizationId: req.user.organizationId,
        branchId,
      })),
      skipDuplicates: true,
    })
  }

  const { passwordHash: _ph, ...userWithoutPassword } = user
  res.status(201).json(userWithoutPassword)
})

// GET /users/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const user = await prisma.user.findFirst({
    where: { id, organizationId: req.user.organizationId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      avatarUrl: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      roles: { include: { role: true } },
      branchAccess: { include: { branch: true } },
    },
  })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')
  res.json(user)
})

// PUT /users/:id
router.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const body = updateUserSchema.parse(req.body)

  const user = await prisma.user.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  const { roleIds, branchIds, password, ...rest } = body

  const updateData: Record<string, unknown> = { ...rest }
  if (password) {
    updateData.passwordHash = await bcrypt.hash(password, config.bcryptRounds)
  }

  await prisma.user.update({ where: { id }, data: updateData })

  if (roleIds !== undefined) {
    await prisma.userRole.deleteMany({ where: { userId: id } })
    if (roleIds.length > 0) {
      await prisma.userRole.createMany({
        data: roleIds.map((roleId) => ({ userId: id, roleId })),
        skipDuplicates: true,
      })
    }
  }

  if (branchIds !== undefined) {
    await prisma.userBranchAccess.deleteMany({ where: { userId: id } })
    if (branchIds.length > 0) {
      await prisma.userBranchAccess.createMany({
        data: branchIds.map((branchId) => ({
          userId: id,
          organizationId: req.user.organizationId,
          branchId,
        })),
        skipDuplicates: true,
      })
    }
  }

  const updated = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      isActive: true,
      roles: { include: { role: true } },
      branchAccess: { include: { branch: true } },
    },
  })

  res.json(updated)
})

// DELETE /users/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string

  const user = await prisma.user.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  await prisma.userRole.deleteMany({ where: { userId: id } })
  await prisma.userBranchAccess.deleteMany({ where: { userId: id } })
  await prisma.refreshToken.deleteMany({ where: { userId: id } })
  await prisma.notification.deleteMany({ where: { userId: id } })
  await prisma.user.delete({ where: { id } })

  res.json({ message: 'User deleted' })
})

export default router
