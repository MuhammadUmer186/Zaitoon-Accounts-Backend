import { NAVIGATION_PATHS } from '../utils/navigation'
import { publish } from '../utils/liveEvents'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { getUserPermissions } from '../utils/permissions'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { AppError } from '../middleware/error'
import { imageUpload, removeUpload } from '../middleware/imageUpload'
import { ONLINE_ORDER_TYPES } from '../utils/onlineOrder'
import { DATE_FORMATS, REGIONS, currencyDecimals, isValidCurrency, isValidLocale, regionFor, countryDefaults } from '../utils/regions'
import { isValidTimezone } from '../utils/menu'

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
  purchaseOrderEnabled: z.boolean().optional(),
  hiddenNavigation: z.array(z.enum(NAVIGATION_PATHS)).max(NAVIGATION_PATHS.length)
    .transform((paths) => NAVIGATION_PATHS.filter((path) => paths.includes(path))).optional(),
  multiBranch: z.boolean().optional(),
  requireAdminMfa: z.boolean().optional(),
  foodCostMethod: z.enum(['issues', 'recipes']).optional(),
  requireTillForCash: z.boolean().optional(),
  offlinePosEnabled: z.boolean().optional(),
  maxStaffDiscountPct: z.number().min(0).max(100).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  // regional settings (filled from the country, editable)
  currency: z.string().trim().toUpperCase().refine(isValidCurrency, 'Unknown currency code').optional(),
  locale: z.string().trim().refine(isValidLocale, 'Unknown number/date locale').optional(),
  timezone: z.string().trim().refine(isValidTimezone, 'Unknown time zone').optional(),
  dateFormat: z.enum(DATE_FORMATS).optional(),
  taxLabel: z.string().trim().min(1).max(24).optional(),
  fiscalYearStart: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use MM-DD').optional(),
  // which of Dine-in / Takeaway / Delivery the public online menu offers
  onlineOrderTypes: z.array(z.enum(ONLINE_ORDER_TYPES)).max(ONLINE_ORDER_TYPES.length)
    .transform((types) => ONLINE_ORDER_TYPES.filter((t) => types.includes(t))).optional(),
})

// GET /orgs/regions — the country catalogue behind Settings → Regional
router.get('/regions', (_req: Request, res: Response) => {
  res.json({ regions: REGIONS.map((r) => ({ ...r, currencyDecimals: currencyDecimals(r.currency) })), dateFormats: DATE_FORMATS })
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
  const { logoPath: _logoPath, ...rest } = org
  res.json({ ...rest, defaultTaxRate: regionFor(org.country)?.taxRate ?? 0, brandLogoUrl: brandingLogoUrl(org) })
})

// PUT /orgs/:orgId
router.put('/:orgId', async (req: Request, res: Response) => {
  const { orgId } = req.params
  if (orgId !== req.user.organizationId) {
    res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
    return
  }

  const body = orgSettingsSchema.parse(req.body)

  // Organization settings need can_manage_settings (Super Admin). The one
  // exception is the low-stock threshold, which the Alerts page edits.
  const { permissions } = await getUserPermissions(prisma, req.user.id)
  const touchesSettings = Object.keys(body).some((k) => k !== 'lowStockThreshold')
  if (touchesSettings && !permissions.has('can_manage_settings')) {
    res.status(403).json({ message: 'Missing required permission: can_manage_settings', code: 'FORBIDDEN' })
    return
  }
  if (!touchesSettings && !permissions.has('can_manage_settings') && !permissions.has('can_view_alerts')) {
    res.status(403).json({ message: 'Missing required permission: can_view_alerts', code: 'FORBIDDEN' })
    return
  }

  // Single-branch mode works with exactly one branch
  if (body.multiBranch === false) {
    const active = await prisma.branch.findMany({ where: { organizationId: orgId, isActive: true }, select: { name: true } })
    if (active.length !== 1) {
      res.status(400).json({
        message: active.length === 0 ? 'Create or activate one restaurant location under Branches before turning off multiple branches.' : `Single-branch mode needs exactly one active branch — you have ${active.length} (${active.map((b) => b.name).join(', ')}). Deactivate the others under Branches first.`,
        code: 'TOO_MANY_BRANCHES',
      })
      return
    }
  }

  if (body.country && !regionFor(body.country)) throw new AppError('Select a supported country', 400, 'VALIDATION_ERROR')
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId} FOR UPDATE`
    const current = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { country: true, offlinePosEnabled: true } })
    const defaults = body.country && body.country !== current.country ? countryDefaults(body.country) : {}
    const disabling = body.offlinePosEnabled === false && current.offlinePosEnabled
    const disabledAt = disabling ? new Date() : undefined
    return tx.organization.update({ where: { id: orgId }, data: {
      ...defaults, ...body,
      ...(disabledAt && { offlinePosDisabledAt: disabledAt, offlinePosRevokedAt: { push: disabledAt } }),
    } })
  })
  publish({ topic: 'settings', action: 'settings_updated', organizationId: orgId })
  const { logoPath: _logoPath, ...rest } = updated
  res.json({ ...rest, defaultTaxRate: regionFor(updated.country)?.taxRate ?? 0, brandLogoUrl: brandingLogoUrl(updated) })
})

// GET /orgs/:orgId/users
router.get('/:orgId/users', requirePermission('can_manage_users'), async (req: Request, res: Response) => {
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
        mfaEnabled: true,
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
router.put('/:orgId/users/:userId/status', requirePermission('can_manage_users'), async (req: Request, res: Response) => {
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

  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body)
  const updated = await prisma.$transaction(async tx => {
    const updated = await tx.user.update({
      where: { id: userId }, data: { isActive },
      select: { id: true, email: true, isActive: true },
    })
    if (!isActive) await tx.refreshToken.deleteMany({ where: { userId } })
    return updated
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

// Org responses never expose the logo's disk path — only where to fetch it
export const brandingLogoUrl = (org: { logoPath: string | null; updatedAt: Date }) =>
  org.logoPath ? `/public/branding/logo?v=${org.updatedAt.getTime()}` : null

// POST /orgs/:orgId/logo — multipart "logo". The portal strips the
// background and sends a transparent PNG; only PNG is accepted so reports
// and every page can rely on transparency.
router.post('/:orgId/logo', requirePermission('can_manage_settings'), imageUpload('branding').single('logo'), async (req: Request, res: Response) => {
  const file = req.file
  if (!file) throw new AppError('No logo uploaded', 400, 'VALIDATION_ERROR')
  if (req.params.orgId !== req.user.organizationId || file.mimetype !== 'image/png') {
    removeUpload(file.path)
    if (req.params.orgId !== req.user.organizationId) throw new AppError('Forbidden', 403, 'FORBIDDEN')
    throw new AppError('The logo must be a transparent PNG', 400, 'INVALID_FILE_TYPE')
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  removeUpload(org.logoPath)
  const updated = await prisma.organization.update({ where: { id: org.id }, data: { logoPath: file.path } })
  res.json({ logoUrl: brandingLogoUrl(updated) })
})

// DELETE /orgs/:orgId/logo — back to the default FoodSync logo
router.delete('/:orgId/logo', requirePermission('can_manage_settings'), async (req: Request, res: Response) => {
  if (req.params.orgId !== req.user.organizationId) throw new AppError('Forbidden', 403, 'FORBIDDEN')
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  removeUpload(org.logoPath)
  await prisma.organization.update({ where: { id: org.id }, data: { logoPath: null } })
  res.json({ logoUrl: null })
})

export default router
