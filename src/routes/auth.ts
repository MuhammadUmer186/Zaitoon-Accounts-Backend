import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { resolveScope } from '../utils/branchScope'
import { assertLoginAllowed, recordLoginFailure, clearLoginFailures } from '../utils/rateLimit'
import { z } from 'zod'
import { prisma } from '../config'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'
import { getUserPermissions } from '../utils/permissions'
import jwt from 'jsonwebtoken'
import QRCode from 'qrcode'
import { config } from '../config'
import { logAudit } from '../utils/audit'
import { verifyTotp, decryptSecret, encryptSecret, newTotpSecret, otpauthUri, newRecoveryCodes, publicUser } from '../utils/totp'

const router = Router()

const loginSchema = z.object({
  email: z.string().trim().email(),
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

// Issues the session for a user who has passed every login check
async function completeLogin(res: Response, user: { id: string; organizationId: string; email: string } & Record<string, unknown>) {
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

  res.json({
    user: publicUser(user),
    tokens: { accessToken, refreshToken, expiresIn: 900 },
    permissionMatrix,
    branches,
    mfaSetupRequired: await mfaSetupRequired(user.id, user.organizationId, permissionMatrix.roles),
  })
}

// Admins must set up two-factor when the organization requires it
async function mfaSetupRequired(userId: string, organizationId: string, roles: string[]) {
  if (!roles.some((r) => ['super_admin', 'admin', 'owner'].includes(r))) return false
  const [org, user] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { requireAdminMfa: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true } }),
  ])
  return !!org?.requireAdminMfa && !user?.mfaEnabled
}

const MFA_TICKET_TTL = '5m'
const signMfaTicket = (userId: string) => jwt.sign({ userId, purpose: 'mfa-login' }, config.jwtSecret, { expiresIn: MFA_TICKET_TTL })

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body)
    // Brute-force protection: 5 failures for an email (or 25 from one IP)
    // lock sign-in for 15 minutes
    assertLoginAllowed(req, body.email)

    // Find user by email across all orgs (email is unique per org, find any
    // matching). Case-insensitive and trimmed — mobile keyboards capitalize
    // the first letter and autofill can add a trailing space.
    const user = await prisma.user.findFirst({
      where: { email: { equals: body.email.trim(), mode: 'insensitive' }, isActive: true },
      include: { organization: true },
    })

    if (!user) {
      recordLoginFailure(req, body.email)
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS')
    }

    const passwordMatch = await bcrypt.compare(body.password, user.passwordHash)
    if (!passwordMatch) {
      recordLoginFailure(req, body.email)
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS')
    }

    // Two-factor: the password alone doesn't open a session — hand back a
    // short-lived ticket to exchange, with a code, at /auth/login/mfa
    if (user.mfaEnabled && user.mfaSecret) {
      res.json({ mfaRequired: true, mfaTicket: signMfaTicket(user.id) })
      return
    }

    clearLoginFailures(req, body.email)
    await completeLogin(res, user)
  } catch (err) {
    if (err instanceof AppError) throw err
    if (err instanceof z.ZodError) {
      res.status(400).json({ message: err.errors[0].message, code: 'VALIDATION_ERROR' })
      return
    }
    throw err
  }
})

// POST /auth/login/mfa — second step: 6-digit authenticator code or a recovery code
const mfaLoginSchema = z.object({ mfaTicket: z.string(), code: z.string().trim().min(6) })

router.post('/login/mfa', async (req: Request, res: Response) => {
  const body = mfaLoginSchema.parse(req.body)
  let userId: string
  try {
    const payload = jwt.verify(body.mfaTicket, config.jwtSecret) as { userId: string; purpose: string }
    if (payload.purpose !== 'mfa-login') throw new Error('wrong purpose')
    userId = payload.userId
  } catch {
    throw new AppError('Your sign-in expired — enter your password again', 401, 'MFA_TICKET_EXPIRED')
  }

  const user = await prisma.user.findFirst({ where: { id: userId, isActive: true }, include: { organization: true } })
  if (!user || !user.mfaEnabled || !user.mfaSecret) throw new AppError('Sign in again', 401, 'MFA_TICKET_EXPIRED')
  assertLoginAllowed(req, user.email)

  const step = verifyTotp(decryptSecret(user.mfaSecret), body.code)
  if (step !== null) {
    if (user.mfaLastStep !== null && step <= user.mfaLastStep) {
      recordLoginFailure(req, user.email)
      throw new AppError('That code was already used — wait for the next one', 401, 'MFA_CODE_REUSED')
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaLastStep: step } })
  } else {
    // Recovery code: each works once
    const normalized = body.code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    let usedIndex = -1
    for (let i = 0; i < user.mfaRecoveryCodes.length; i++) {
      if (await bcrypt.compare(normalized, user.mfaRecoveryCodes[i])) { usedIndex = i; break }
    }
    if (usedIndex < 0) {
      recordLoginFailure(req, user.email)
      throw new AppError('Invalid code', 401, 'MFA_CODE_INVALID')
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaRecoveryCodes: user.mfaRecoveryCodes.filter((_, i) => i !== usedIndex) } })
  }

  clearLoginFailures(req, user.email)
  await completeLogin(res, user)
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
  // Branch-scoped users (store keeper) only get their own branch
  const scope = await resolveScope(user.id, user.organizationId)
  const branches = await prisma.branch.findMany({
    where: { organizationId: user.organizationId, isActive: true, ...(scope.restricted && { id: { in: scope.branchIds } }) },
    orderBy: { name: 'asc' },
  })

  res.json({
    user: publicUser(user),
    permissionMatrix,
    branches,
    mfaSetupRequired: await mfaSetupRequired(user.id, user.organizationId, permissionMatrix.roles),
  })
})

// PUT /auth/me
router.put('/me', authenticate, async (req: Request, res: Response) => {
  const body = updateMeSchema.parse(req.body)

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: body,
  })

  res.json({ user: publicUser(updated) })
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


// ── Two-factor (MFA) management for the signed-in user ─────────────────────

const RECOVERY_HASH_ROUNDS = 8
const hashRecovery = (codes: string[]) => Promise.all(codes.map((c) => bcrypt.hash(c.replace(/[^A-Z0-9]/g, ''), RECOVERY_HASH_ROUNDS)))

// GET /auth/mfa
router.get('/mfa', authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { mfaEnabled: true, mfaRecoveryCodes: true, organizationId: true } })
  const org = user ? await prisma.organization.findUnique({ where: { id: user.organizationId }, select: { requireAdminMfa: true } }) : null
  res.json({ enabled: !!user?.mfaEnabled, recoveryCodesLeft: user?.mfaRecoveryCodes.length ?? 0, requiredForAdmins: !!org?.requireAdminMfa })
})

// POST /auth/mfa/setup — new secret + QR code; not active until confirmed
router.post('/mfa/setup', authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')
  if (user.mfaEnabled) throw new AppError('Two-factor is already on — turn it off first to set up a new device', 400, 'MFA_ALREADY_ENABLED')
  const secret = newTotpSecret()
  await prisma.user.update({ where: { id: user.id }, data: { mfaPendingSecret: encryptSecret(secret) } })
  const otpauthUrl = otpauthUri(secret, user.email)
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 })
  res.json({ secret, otpauthUrl, qrDataUrl })
})

// POST /auth/mfa/enable — confirm with a code from the app; returns recovery codes once
router.post('/mfa/enable', authenticate, async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim() }).parse(req.body)
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user?.mfaPendingSecret) throw new AppError('Start the setup again', 400, 'MFA_NOT_STARTED')
  const step = verifyTotp(decryptSecret(user.mfaPendingSecret), code)
  if (step === null) throw new AppError('That code is not right — check the time on your phone and try the newest code', 400, 'MFA_CODE_INVALID')
  const recoveryCodes = newRecoveryCodes()
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true, mfaSecret: user.mfaPendingSecret, mfaPendingSecret: null, mfaLastStep: step, mfaRecoveryCodes: await hashRecovery(recoveryCodes) },
  })
  await logAudit(prisma, { req, action: 'mfa.enabled', module: 'users', resourceType: 'user', resourceId: user.id })
  res.json({ enabled: true, recoveryCodes })
})

async function assertPasswordAndCode(userId: string, password: string, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user || !user.mfaEnabled || !user.mfaSecret) throw new AppError('Two-factor is not on', 400, 'MFA_NOT_ENABLED')
  if (!(await bcrypt.compare(password, user.passwordHash))) throw new AppError('Password is incorrect', 400, 'INVALID_PASSWORD')
  if (verifyTotp(decryptSecret(user.mfaSecret), code) === null) throw new AppError('Authenticator code is incorrect', 400, 'MFA_CODE_INVALID')
  return user
}

// POST /auth/mfa/disable — needs password + current code
router.post('/mfa/disable', authenticate, async (req: Request, res: Response) => {
  const body = z.object({ password: z.string().min(1), code: z.string().trim() }).parse(req.body)
  const user = await assertPasswordAndCode(req.user.id, body.password, body.code)
  const { roles } = await getUserPermissions(prisma, user.id)
  const org = await prisma.organization.findUnique({ where: { id: user.organizationId }, select: { requireAdminMfa: true } })
  if (org?.requireAdminMfa && roles.some((r) => ['super_admin', 'admin', 'owner'].includes(r))) {
    throw new AppError('Your organization requires two-factor for admins, so it cannot be turned off', 400, 'MFA_REQUIRED')
  }
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null, mfaRecoveryCodes: [], mfaLastStep: null } })
  await logAudit(prisma, { req, action: 'mfa.disabled', module: 'users', resourceType: 'user', resourceId: user.id })
  res.json({ enabled: false })
})

// POST /auth/mfa/recovery-codes — replace the recovery codes
router.post('/mfa/recovery-codes', authenticate, async (req: Request, res: Response) => {
  const body = z.object({ password: z.string().min(1), code: z.string().trim() }).parse(req.body)
  const user = await assertPasswordAndCode(req.user.id, body.password, body.code)
  const recoveryCodes = newRecoveryCodes()
  await prisma.user.update({ where: { id: user.id }, data: { mfaRecoveryCodes: await hashRecovery(recoveryCodes) } })
  res.json({ recoveryCodes })
})

export default router
