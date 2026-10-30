import { SYSTEM_EMAIL_DOMAIN } from '../services/payments'
import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma, config } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { AppError } from '../middleware/error'
import { validateUserAccess } from '../services/userAccess'

const router = Router()

router.use(authenticate)
// Users & Roles is Super Admin territory — Administrator doesn't hold this
router.use(requirePermission('can_manage_users'))

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
    // the inactive "Online payments" actor is not a staff account
    NOT: { email: { endsWith: SYSTEM_EMAIL_DOMAIN } },
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

  const user = await prisma.$transaction(async tx => {
    await validateUserAccess(tx, req.user.organizationId, body.roleIds ?? [], body.branchIds ?? [])
    const user = await tx.user.create({
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
      await tx.userRole.createMany({
        data: body.roleIds.map((roleId) => ({ userId: user.id, roleId })),
        skipDuplicates: true,
      })
    }

    if (body.branchIds && body.branchIds.length > 0) {
      await tx.userBranchAccess.createMany({
        data: body.branchIds.map((branchId) => ({
          userId: user.id,
          organizationId: req.user.organizationId,
          branchId,
        })),
        skipDuplicates: true,
      })
    }

    return user
  })

  const { passwordHash: _ph, posPin: _pin, posPinLookup: _lookup, ...userWithoutPassword } = user
  res.status(201).json(userWithoutPassword)
})

// GET /users/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const user = await prisma.user.findFirst({
    where: { id, organizationId: req.user.organizationId, NOT: { email: { endsWith: SYSTEM_EMAIL_DOMAIN } } },
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
    where: { id, organizationId: req.user.organizationId, NOT: { email: { endsWith: SYSTEM_EMAIL_DOMAIN } } },
  })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  const { roleIds, branchIds, password, ...rest } = body

  const passwordHash = password ? await bcrypt.hash(password, config.bcryptRounds) : undefined
  const updated = await prisma.$transaction(async tx => {
    if (roleIds !== undefined || branchIds !== undefined) {
      const [currentRoles, currentBranches] = await Promise.all([
        tx.userRole.findMany({ where: { userId: id }, select: { roleId: true } }),
        tx.userBranchAccess.findMany({ where: { userId: id }, select: { branchId: true } }),
      ])
      await validateUserAccess(
        tx, req.user.organizationId,
        roleIds ?? currentRoles.map((r) => r.roleId),
        branchIds ?? currentBranches.map((b) => b.branchId),
      )
    }

    const updateData: Record<string, unknown> = { ...rest }
    if (password) {
      updateData.passwordHash = passwordHash
    }

    await tx.user.update({ where: { id }, data: updateData })
    if (rest.isActive === false || password) await tx.refreshToken.deleteMany({ where: { userId: id } })

    if (roleIds !== undefined) {
      await tx.userRole.deleteMany({ where: { userId: id } })
      if (roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId: id, roleId })),
          skipDuplicates: true,
        })
      }
    }

    if (branchIds !== undefined) {
      await tx.userBranchAccess.deleteMany({ where: { userId: id } })
      if (branchIds.length > 0) {
        await tx.userBranchAccess.createMany({
          data: branchIds.map((branchId) => ({
            userId: id,
            organizationId: req.user.organizationId,
            branchId,
          })),
          skipDuplicates: true,
        })
      }
    }

    return tx.user.findUnique({
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

  })

  res.json(updated)
})

// DELETE /users/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string

  const user = await prisma.user.findFirst({
    where: { id, organizationId: req.user.organizationId, NOT: { email: { endsWith: SYSTEM_EMAIL_DOMAIN } } },
  })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  await prisma.$transaction(async tx => {
  await tx.userRole.deleteMany({ where: { userId: id } })
  await tx.userBranchAccess.deleteMany({ where: { userId: id } })
  await tx.refreshToken.deleteMany({ where: { userId: id } })
  await tx.notification.deleteMany({ where: { userId: id } })
  await tx.user.delete({ where: { id } })
  })

  res.json({ message: 'User deleted' })
})

export default router
