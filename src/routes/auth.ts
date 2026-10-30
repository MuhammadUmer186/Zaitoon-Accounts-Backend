import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { resolveScope } from '../utils/branchScope'
import { z } from 'zod'
import { prisma } from '../config'
import { signAccessToken, signPosAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt'
import { userForPin } from '../services/posSecurity'
import { rateLimit } from '../middleware/rateLimit'
import { loginRateLimit } from '../middleware/loginRateLimit'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'
import { getUserPermissions } from '../utils/permissions'

const router = Router()

router.post('/pin-login', rateLimit('pin-login', 5, 60000), async (req, res) => {
  const b = z.object({ branchId: z.string().min(1), pin: z.string().regex(/^\d{4,6}$/) }).parse(req.body)
  const branch = await prisma.branch.findFirst({ where: { id: b.branchId, isActive: true, organization: { isActive: true } } })
  if (!branch) throw new AppError('Invalid branch or PIN', 401, 'INVALID_PIN')
  const u = await userForPin(branch.organizationId, branch.id, b.pin)
  const matrix = await buildPermissionMatrix(u.id, u.organizationId)
  if (!matrix.permissions.includes('can_use_pos')) throw new AppError('This PIN cannot use the POS', 403, 'FORBIDDEN')
  const { passwordHash: _password, posPin: _pin, posPinLookup: _lookup, ...user } = u
  const allowedModules = ['pos', 'orders', 'floor']
  res.json({ user, tokens: { accessToken: signPosAccessToken(u.id, u.organizationId, u.email, branch.id), refreshToken: '', expiresIn: 900 },
    permissionMatrix: { ...matrix, roles: ['pos_terminal'], moduleAccess: matrix.moduleAccess.filter((m) => allowedModules.includes(m)), branchIds: [branch.id] }, branches: [branch] })
})

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  organizationId: z.string().trim().min(1).max(100).optional(),
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
  const [{ permissions, roles, moduleAccess }, branchAccess] = await Promise.all([
    getUserPermissions(prisma, userId),
    prisma.userBranchAccess.findMany({ where: { userId, organizationId: orgId } }),
  ])

  return {
    permissions: Array.from(permissions),
    branchIds: branchAccess.map((b) => b.branchId),
    roles,
    moduleAccess: Array.from(moduleAccess),
  }
}

// POST /auth/login
router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body)

    // Email is unique per organization. Shared emails require explicit tenant
    // context so database row order can never select a different account.
    const candidates = await prisma.user.findMany({
      where: { email: { equals: body.email, mode: 'insensitive' }, isActive: true, organization: { isActive: true }, ...(body.organizationId && { organizationId: body.organizationId }) },
      include: { organization: true },
      take: 2,
    })
    if (candidates.length > 1) throw new AppError('Enter the organization ID provided by your administrator to select your account.', 409, 'ORGANIZATION_REQUIRED')
    const user = candidates[0]

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

    const scope = await resolveScope(user.id, user.organizationId)
    const [, permissionMatrix, branches] = await Promise.all([
      prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      buildPermissionMatrix(user.id, user.organizationId),
      prisma.branch.findMany({
        where: { organizationId: user.organizationId, isActive: true, ...(scope.restricted && { id: { in: scope.branchIds } }) },
        orderBy: { name: 'asc' },
      }),
      prisma.refreshToken.create({
        data: { token: refreshToken, userId: user.id, expiresAt },
      }),
    ])

    const { passwordHash: _ph, posPin: _pin, posPinLookup: _lookup, ...userWithoutPassword } = user

    res.json({
      user: userWithoutPassword,
      tokens: { accessToken, refreshToken, expiresIn: 900 },
      permissionMatrix,
      branches,
    })
  } catch (err) {
    if (err instanceof AppError) throw err
    if (err instanceof z.ZodError) {
      res.status(400).json({ message: err.issues[0].message, code: 'VALIDATION_ERROR' })
      return
    }
    throw err
  }
})

// POST /auth/logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  const { refreshToken } = req.body
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken, userId: req.user.id } })
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
      include: { user: { include: { organization: true } } },
    })

    if (!storedToken || storedToken.expiresAt < new Date() || !storedToken.user.isActive || !storedToken.user.organization.isActive) {
      throw new AppError('Refresh token expired or invalid', 401, 'TOKEN_EXPIRED')
    }

    if (storedToken.userId !== payload.userId) {
      throw new AppError('Token mismatch', 401, 'TOKEN_INVALID')
    }

    // Rotate refresh token
    const newAccessToken = signAccessToken(
      storedToken.user.id,
      storedToken.user.organizationId,
      storedToken.user.email
    )
    const newRefreshToken = signRefreshToken(storedToken.user.id)

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)
    await prisma.$transaction(async tx => {
      const removed = await tx.refreshToken.deleteMany({ where: { id: storedToken.id } })
      if (!removed.count) throw new AppError('Refresh token already used', 401, 'TOKEN_INVALID')
      await tx.refreshToken.create({ data: { token: newRefreshToken, userId: storedToken.user.id, expiresAt } })
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
  if (req.user.posBranchId) {
    permissionMatrix.roles = ['pos_terminal']
    permissionMatrix.moduleAccess = permissionMatrix.moduleAccess.filter((m) => ['pos', 'orders', 'floor'].includes(m))
    permissionMatrix.branchIds = [req.user.posBranchId]
  }
  // Branch-scoped users (store keeper) only get their own branch
  const scope = await resolveScope(user.id, user.organizationId)
  const branches = await prisma.branch.findMany({
      where: { organizationId: user.organizationId, isActive: true, ...(req.user.posBranchId ? { id: req.user.posBranchId } : scope.restricted ? { id: { in: scope.branchIds } } : {}) },
    orderBy: { name: 'asc' },
  })

  const { passwordHash: _ph, posPin: _pin, posPinLookup: _lookup, ...userWithoutPassword } = user

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

  const { passwordHash: _ph, posPin: _pin, posPinLookup: _lookup, ...userWithoutPassword } = updated
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
  await prisma.$transaction(async tx => {
    await tx.user.update({ where: { id: req.user.id }, data: { passwordHash } })
    await tx.refreshToken.deleteMany({ where: { userId: req.user.id } })
  })

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
