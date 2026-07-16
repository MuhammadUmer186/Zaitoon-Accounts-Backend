import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../config'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'

const router = Router()

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const updateMeSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

async function buildPermissionMatrix(userId: string, orgId: string) {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: {
        include: {
          permissions: { include: { permission: true } },
        },
      },
    },
  })

  const permissions = new Set<string>()
  const roles: string[] = []
  const moduleAccess = new Set<string>()

  for (const ur of userRoles) {
    roles.push(ur.role.name)
    for (const rp of ur.role.permissions) {
      permissions.add(rp.permission.key)
      moduleAccess.add(rp.permission.module)
    }
  }

  // Super admin gets all permissions
  if (roles.includes('super_admin') || roles.includes('admin')) {
    const allPermissions = await prisma.permission.findMany()
    for (const p of allPermissions) {
      permissions.add(p.key)
      moduleAccess.add(p.module)
    }
  }

  const branchAccess = await prisma.userBranchAccess.findMany({
    where: { userId, organizationId: orgId },
  })

  return {
    permissions: Array.from(permissions),
    branchIds: branchAccess.map((b) => b.branchId),
    roles,
    moduleAccess: Array.from(moduleAccess),
  }
}

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body)

    // Find user by email across all orgs (email is unique per org, find any matching)
    const user = await prisma.user.findFirst({
      where: { email: body.email, isActive: true },
      include: { organization: true },
    })

    if (!user) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS')
    }

    const passwordMatch = await bcrypt.compare(body.password, user.passwordHash)
    if (!passwordMatch) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS')
    }

    const accessToken = signAccessToken(user.id, user.organizationId, user.email)
    const refreshToken = signRefreshToken(user.id)

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    const [, permissionMatrix, branches] = await Promise.all([
      prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      buildPermissionMatrix(user.id, user.organizationId),
      prisma.branch.findMany({
        where: { organizationId: user.organizationId, isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.refreshToken.create({
        data: { token: refreshToken, userId: user.id, expiresAt },
      }),
    ])

    const { passwordHash: _ph, ...userWithoutPassword } = user

    res.json({
      user: userWithoutPassword,
      tokens: { accessToken, refreshToken, expiresIn: 900 },
      permissionMatrix,
      branches,
    })
  } catch (err) {
    if (err instanceof AppError) throw err
    if (err instanceof z.ZodError) {
      res.status(400).json({ message: err.errors[0].message, code: 'VALIDATION_ERROR' })
      return
    }
    throw err
  }
})

// POST /auth/logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  const { refreshToken } = req.body
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } })
  }
  res.json({ message: 'Logged out successfully' })
})

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) {
      throw new AppError('Refresh token required', 400, 'MISSING_TOKEN')
    }

    const payload = verifyRefreshToken(refreshToken)

    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    })

    if (!storedToken || storedToken.expiresAt < new Date()) {
      throw new AppError('Refresh token expired or invalid', 401, 'TOKEN_EXPIRED')
    }

    if (storedToken.userId !== payload.userId) {
      throw new AppError('Token mismatch', 401, 'TOKEN_INVALID')
    }

    // Rotate refresh token
    await prisma.refreshToken.delete({ where: { id: storedToken.id } })
    const newAccessToken = signAccessToken(
      storedToken.user.id,
      storedToken.user.organizationId,
      storedToken.user.email
    )
    const newRefreshToken = signRefreshToken(storedToken.user.id)

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)
    await prisma.refreshToken.create({
      data: { token: newRefreshToken, userId: storedToken.user.id, expiresAt },
    })

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
    })
  } catch (err) {
    if (err instanceof AppError) throw err
    res.status(401).json({ message: 'Invalid refresh token', code: 'TOKEN_INVALID' })
  }
})

// GET /auth/me
router.get('/me', authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { organization: true },
  })

  if (!user) {
    throw new AppError('User not found', 404, 'NOT_FOUND')
  }

  const permissionMatrix = await buildPermissionMatrix(user.id, user.organizationId)
  const branches = await prisma.branch.findMany({
    where: { organizationId: user.organizationId, isActive: true },
    orderBy: { name: 'asc' },
  })

  const { passwordHash: _ph, ...userWithoutPassword } = user

  res.json({
    user: userWithoutPassword,
    permissionMatrix,
    branches,
  })
})

// PUT /auth/me
router.put('/me', authenticate, async (req: Request, res: Response) => {
  const body = updateMeSchema.parse(req.body)

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: body,
  })

  const { passwordHash: _ph, ...userWithoutPassword } = updated
  res.json({ user: userWithoutPassword })
})

// PUT /auth/me/password
router.put('/me/password', authenticate, async (req: Request, res: Response) => {
  const body = changePasswordSchema.parse(req.body)

  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')

  const valid = await bcrypt.compare(body.currentPassword, user.passwordHash)
  if (!valid) throw new AppError('Current password is incorrect', 400, 'WRONG_PASSWORD')

  const passwordHash = await bcrypt.hash(body.newPassword, 10)
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } })

  res.json({ message: 'Password updated successfully' })
})

// POST /auth/forgot-password (mock)
router.post('/forgot-password', async (_req: Request, res: Response) => {
  res.json({ message: 'If the email exists, a reset link has been sent' })
})

// POST /auth/reset-password (mock)
router.post('/reset-password', async (_req: Request, res: Response) => {
  res.json({ message: 'Password reset successfully' })
})

export default router
