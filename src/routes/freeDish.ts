import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { parsePhoneNumberFromString, isSupportedCountry, CountryCode } from 'libphonenumber-js'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter, getBranchScope } from '../utils/branchScope'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { logAudit } from '../utils/audit'
import { ProReport, ReportRow, sendProReport, reportScope, dateLineFor, fmtDateShort, plural } from '../utils/proReport'

// Free Dish module.
//
//  1. Staff create a QR code for a section of a branch (FreeDishQr). It
//     encodes the public form URL  <portal>/fd/<token>.
//  2. A guest scans it and submits the bio-data form (public endpoints below,
//     no login). They get a personal voucher (FreeDishSubmission) whose QR
//     encodes  <portal>/fd/v/<voucherCode>  — "Go to Zaitoon X Branch's Y
//     section". One voucher per WhatsApp number and per email for each QR;
//     submitting again returns the same voucher.
//  3. At the section, staff scan the voucher (USB 2D scanner, phone camera or
//     webcam) — verify shows who it belongs to, redeem marks it used, once.

const PERM_MANAGE = 'free_dish_manage'
const PERM_REDEEM = 'free_dish_redeem'

// Voucher codes avoid look-alike characters (0/O, 1/I) so they can also be typed
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const randomCode = (len: number) => Array.from({ length: len }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')
const newVoucherCode = () => `FD-${randomCode(5)}-${randomCode(5)}`
const newQrToken = () => crypto.randomBytes(12).toString('base64url')

// Accepts a bare code, a code without dashes, or the full voucher URL a
// camera/2D scanner reads out of the QR
export function extractVoucherCode(input: string): string | null {
  const m = input.toUpperCase().match(/FD-?([A-Z0-9]{5})-?([A-Z0-9]{5})/)
  return m ? `FD-${m[1]}-${m[2]}` : null
}

// "Zaitoon Olaya" → "Olaya" so the statement doesn't read "Zaitoon Zaitoon …"
const branchShortName = (name: string) => name.replace(/^zaitoon\s+/i, '').trim() || name
export const voucherStatement = (branch: string, section: string) => `Go to Zaitoon ${branchShortName(branch)} Branch's ${section} section`

type VoucherWithQr = Prisma.FreeDishSubmissionGetPayload<{ include: { qr: { include: { branch: { select: { name: true } }; section: { select: { name: true } } } } } }>
const voucherInclude = { qr: { include: { branch: { select: { name: true } }, section: { select: { name: true } } } } } as const

const isExpired = (v: { expiresAt: Date | null }) => !!v.expiresAt && v.expiresAt < new Date()
const voucherState = (v: VoucherWithQr) => (v.status === 'redeemed' ? 'redeemed' : isExpired(v) ? 'expired' : 'valid')

// What the guest's own voucher page shows (first name only)
function publicVoucher(v: VoucherWithQr) {
  return {
    code: v.voucherCode,
    firstName: v.name.trim().split(/\s+/)[0],
    offer: v.qr.offer,
    branchName: v.qr.branch.name,
    sectionName: v.qr.section.name,
    statement: voucherStatement(v.qr.branch.name, v.qr.section.name),
    state: voucherState(v),
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    redeemedAt: v.redeemedAt,
  }
}

// ── Public (guest) endpoints — mounted at /public/free-dish, no login ──────

export const publicFreeDishRouter = Router()

// Guests on shared Wi-Fi share an IP, so the limit is generous; it only stops
// scripted form flooding.
const submitLog = new Map<string, number[]>()
function assertSubmitAllowed(ip: string) {
  const now = Date.now()
  const recent = (submitLog.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000)
  if (recent.length >= 30) throw new AppError('Too many submissions from this network. Please try again later.', 429, 'TOO_MANY_ATTEMPTS')
  recent.push(now)
  submitLog.set(ip, recent)
}
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [ip, times] of submitLog) if (!times.some((t) => t > cutoff)) submitLog.delete(ip)
}, 10 * 60 * 1000).unref()

async function loadActiveQr(token: string) {
  const qr = await prisma.freeDishQr.findUnique({
    where: { token },
    include: { branch: { select: { name: true, isActive: true } }, section: { select: { name: true } } },
  })
  if (!qr) throw new AppError('This QR code is not valid', 404, 'NOT_FOUND')
  if (!qr.isActive || !qr.branch.isActive) throw new AppError('This offer is no longer available', 410, 'OFFER_CLOSED')
  return qr
}

publicFreeDishRouter.get('/qr/:token', async (req: Request, res: Response) => {
  const qr = await loadActiveQr(req.params.token)
  res.json({ offer: qr.offer, branchName: qr.branch.name, sectionName: qr.section.name, statement: voucherStatement(qr.branch.name, qr.section.name) })
})

const submitSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(120),
  country: z.string().trim().length(2, 'Choose your country'),
  whatsappCountry: z.string().trim().length(2),
  whatsapp: z.string().trim().min(4, 'Enter your WhatsApp number').max(30),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(160),
})

publicFreeDishRouter.post('/qr/:token/submit', async (req: Request, res: Response) => {
  assertSubmitAllowed(req.ip || 'unknown')
  const qr = await loadActiveQr(req.params.token)
  const body = submitSchema.parse(req.body)

  const country = body.country.toUpperCase()
  const phoneCountry = body.whatsappCountry.toUpperCase()
  if (!isSupportedCountry(country) || !isSupportedCountry(phoneCountry)) throw new AppError('Choose a valid country', 400, 'VALIDATION_ERROR')
  const phone = parsePhoneNumberFromString(body.whatsapp, phoneCountry as CountryCode)
  if (!phone || !phone.isValid()) throw new AppError('Enter a valid WhatsApp number for the selected country code', 400, 'INVALID_PHONE')
  const whatsapp = phone.number

  const dob = new Date(`${body.dateOfBirth}T00:00:00Z`)
  const today = new Date()
  if (isNaN(dob.getTime()) || dob > today || dob.getUTCFullYear() < today.getUTCFullYear() - 120) {
    throw new AppError('Enter a valid date of birth', 400, 'VALIDATION_ERROR')
  }

  // Same guest again → same voucher (they may have lost the page)
  const existing = await prisma.freeDishSubmission.findFirst({
    where: { qrId: qr.id, OR: [{ whatsapp }, { email: body.email }] },
    include: voucherInclude,
  })
  if (existing) {
    if (existing.whatsapp !== whatsapp) throw new AppError('This email address has already been used for this offer', 409, 'DUPLICATE_EMAIL')
    return res.json({ voucher: publicVoucher(existing), existing: true })
  }

  const expiresAt = qr.voucherValidDays ? new Date(Date.now() + qr.voucherValidDays * 86400000) : null
  let created: VoucherWithQr | null = null
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      created = await prisma.freeDishSubmission.create({
        data: {
          organizationId: qr.organizationId, qrId: qr.id, branchId: qr.branchId, sectionId: qr.sectionId,
          name: body.name, whatsapp, country, dateOfBirth: dob, email: body.email,
          voucherCode: newVoucherCode(), expiresAt, ipAddress: req.ip,
        },
        include: voucherInclude,
      })
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err
      const target = String(err.meta?.target ?? '')
      if (target.includes('voucherCode')) continue // code collision — draw another
      // the same guest submitted twice at once
      const again = await prisma.freeDishSubmission.findFirst({ where: { qrId: qr.id, whatsapp }, include: voucherInclude })
      if (again) return res.json({ voucher: publicVoucher(again), existing: true })
      throw new AppError('This email address has already been used for this offer', 409, 'DUPLICATE_EMAIL')
    }
  }
  if (!created) throw new AppError('Could not create your voucher, please try again', 500, 'VOUCHER_FAILED')
  res.status(201).json({ voucher: publicVoucher(created), existing: false })
})

publicFreeDishRouter.get('/voucher/:code', async (req: Request, res: Response) => {
  const code = extractVoucherCode(req.params.code)
  const v = code ? await prisma.freeDishSubmission.findUnique({ where: { voucherCode: code }, include: voucherInclude }) : null
  if (!v) throw new AppError('Voucher not found', 404, 'NOT_FOUND')
  res.json({ voucher: publicVoucher(v) })
})

// ── Staff endpoints — mounted at /free-dish ─────────────────────────────────

const router = Router()
router.use(authenticate)

// Sections of a branch to place a QR in (the same sections Inventory uses)
router.get('/sections', requireAnyPermission(PERM_MANAGE, PERM_REDEEM), async (req: Request, res: Response) => {
  const branchId = await branchFilter(req, (req.query.branchId as string) || undefined)
  const sections = await prisma.branchSection.findMany({
    where: { organizationId: req.user.organizationId, isActive: true, ...(branchId && { branchId }) },
    include: { branch: { select: { name: true } } },
    orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
  })
  res.json({ data: sections.map((s) => ({ id: s.id, name: s.name, branchId: s.branchId, branchName: s.branch.name })) })
})

router.post('/sections', requirePermission(PERM_MANAGE), async (req: Request, res: Response) => {
  const body = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(80) }).parse(req.body)
  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: req.user.organizationId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, branch.id)
  const existing = await prisma.branchSection.findUnique({ where: { branchId_name: { branchId: branch.id, name: body.name } } })
  const section = existing
    ? await prisma.branchSection.update({ where: { id: existing.id }, data: { isActive: true } })
    : await prisma.branchSection.create({ data: { organizationId: req.user.organizationId, branchId: branch.id, name: body.name } })
  res.status(201).json({ id: section.id, name: section.name, branchId: branch.id, branchName: branch.name })
})

// ── QR codes
const qrInclude = {
  branch: { select: { name: true } },
  section: { select: { name: true } },
  _count: { select: { submissions: true } },
} as const

router.get('/qr-codes', requirePermission(PERM_MANAGE), async (req: Request, res: Response) => {
  const branchId = await branchFilter(req, (req.query.branchId as string) || undefined)
  const qrs = await prisma.freeDishQr.findMany({
    where: { organizationId: req.user.organizationId, ...(branchId && { branchId }) },
    include: qrInclude,
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  })
  const redeemed = await prisma.freeDishSubmission.groupBy({
    by: ['qrId'], where: { qrId: { in: qrs.map((q) => q.id) }, status: 'redeemed' }, _count: true,
  })
  const redeemedBy = new Map(redeemed.map((r) => [r.qrId, r._count]))
  res.json({
    data: qrs.map((q) => ({
      id: q.id, name: q.name, offer: q.offer, token: q.token, isActive: q.isActive, voucherValidDays: q.voucherValidDays,
      branchId: q.branchId, branchName: q.branch.name, sectionId: q.sectionId, sectionName: q.section.name,
      statement: voucherStatement(q.branch.name, q.section.name),
      submissions: q._count.submissions, redeemed: redeemedBy.get(q.id) ?? 0, createdAt: q.createdAt,
    })),
  })
})

const qrSchema = z.object({
  name: z.string().trim().min(1).max(120),
  offer: z.string().trim().min(1).max(120).default('Free dish'),
  branchId: z.string().min(1),
  sectionId: z.string().min(1),
  voucherValidDays: z.number().int().min(1).max(365).nullable().optional(),
  isActive: z.boolean().optional(),
})

async function checkSection(req: Request, branchId: string, sectionId: string) {
  await assertBranchAccess(req, branchId)
  const section = await prisma.branchSection.findFirst({ where: { id: sectionId, branchId, organizationId: req.user.organizationId } })
  if (!section) throw new AppError('Choose a section of the selected branch', 400, 'VALIDATION_ERROR')
}

router.post('/qr-codes', requirePermission(PERM_MANAGE), async (req: Request, res: Response) => {
  const body = qrSchema.parse(req.body)
  await checkSection(req, body.branchId, body.sectionId)
  const qr = await prisma.freeDishQr.create({
    data: {
      organizationId: req.user.organizationId, branchId: body.branchId, sectionId: body.sectionId, name: body.name, offer: body.offer,
      voucherValidDays: body.voucherValidDays ?? null, isActive: body.isActive ?? true, token: newQrToken(), createdBy: req.user.id,
    },
  })
  await logAudit(prisma, { req, action: 'free_dish.qr_created', module: 'free_dish', resourceType: 'FreeDishQr', resourceId: qr.id, resourceRef: qr.name, branchId: qr.branchId })
  res.status(201).json({ id: qr.id, token: qr.token })
})

router.put('/qr-codes/:id', requirePermission(PERM_MANAGE), async (req: Request, res: Response) => {
  const qr = await prisma.freeDishQr.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!qr) throw new AppError('QR code not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, qr.branchId)
  const body = qrSchema.parse(req.body)
  await checkSection(req, body.branchId, body.sectionId)
  const used = await prisma.freeDishSubmission.count({ where: { qrId: qr.id } })
  if (used > 0 && (body.branchId !== qr.branchId || body.sectionId !== qr.sectionId)) {
    throw new AppError('Guests already have vouchers for this section — create a new QR code for a different section', 400, 'QR_IN_USE')
  }
  await prisma.freeDishQr.update({
    where: { id: qr.id },
    data: { name: body.name, offer: body.offer, branchId: body.branchId, sectionId: body.sectionId, voucherValidDays: body.voucherValidDays ?? null, isActive: body.isActive ?? qr.isActive },
  })
  await logAudit(prisma, { req, action: 'free_dish.qr_updated', module: 'free_dish', resourceType: 'FreeDishQr', resourceId: qr.id, resourceRef: body.name, branchId: body.branchId })
  res.json({ success: true })
})

router.delete('/qr-codes/:id', requirePermission(PERM_MANAGE), async (req: Request, res: Response) => {
  const qr = await prisma.freeDishQr.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!qr) throw new AppError('QR code not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, qr.branchId)
  const used = await prisma.freeDishSubmission.count({ where: { qrId: qr.id } })
  if (used > 0) {
    await prisma.freeDishQr.update({ where: { id: qr.id }, data: { isActive: false } })
    return res.json({ message: 'QR code switched off (guests have already registered with it)' })
  }
  await prisma.freeDishQr.delete({ where: { id: qr.id } })
  await logAudit(prisma, { req, action: 'free_dish.qr_deleted', module: 'free_dish', resourceType: 'FreeDishQr', resourceId: qr.id, resourceRef: qr.name, branchId: qr.branchId })
  res.json({ message: 'QR code deleted' })
})

const phoneSearchTerms = (search: string) => {
  const digits = search.replace(/\D/g, '')
  if (digits.length < 3) return []
  const trimmed = digits.replace(/^0+/, '')
  return [...new Set([digits, trimmed].filter((d) => d.length >= 3))]
}

// ── Submissions (registered guests) — list, summary, export
router.get('/submissions', requirePermission(PERM_MANAGE), async (req: Request, res: Response) => {
  const { search, status, qrId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const branchId = await branchFilter(req, (req.query.branchId as string) || undefined)
  const toEnd = toDate ? new Date(`${toDate}T23:59:59.999Z`) : undefined
  const where: Prisma.FreeDishSubmissionWhereInput = {
    organizationId: orgId,
    ...(branchId && { branchId }),
    ...(qrId && { qrId }),
    ...(status === 'redeemed' && { status: 'redeemed' }),
    ...(status === 'issued' && { status: 'issued', OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }] }),
    ...(status === 'expired' && { status: 'issued', expiresAt: { lt: new Date() } }),
    ...((fromDate || toEnd) && { createdAt: { ...(fromDate && { gte: new Date(fromDate) }), ...(toEnd && { lte: toEnd }) } }),
    ...(search?.trim() && {
      AND: [{
        OR: [
          { name: { contains: search.trim(), mode: 'insensitive' } },
          { email: { contains: search.trim(), mode: 'insensitive' } },
          // numbers are stored as +9665…; a local "05…" search matches without its leading zeros
          ...phoneSearchTerms(search).map((term) => ({ whatsapp: { contains: term } })),
          { voucherCode: { contains: search.trim().toUpperCase() } },
        ],
      }],
    }),
  }

  const include = { qr: { select: { name: true, offer: true, branch: { select: { name: true } }, section: { select: { name: true } } } } } as const
  const shape = (s: Prisma.FreeDishSubmissionGetPayload<{ include: typeof include }>) => ({
    id: s.id, name: s.name, whatsapp: s.whatsapp, country: s.country, dateOfBirth: s.dateOfBirth, email: s.email,
    voucherCode: s.voucherCode, state: s.status === 'redeemed' ? 'redeemed' : isExpired(s) ? 'expired' : 'issued',
    qrName: s.qr.name, offer: s.qr.offer, branchName: s.qr.branch.name, sectionName: s.qr.section.name,
    createdAt: s.createdAt, redeemedAt: s.redeemedAt, expiresAt: s.expiresAt,
  })

  if (format) {
    const rows = (await prisma.freeDishSubmission.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 20000 })).map(shape)
    const redeemedCount = rows.filter((r) => r.state === 'redeemed').length
    const report: ProReport = {
      key: 'free-dish-registrations',
      title: 'Free Dish Registrations',
      eyebrow: 'Free Dish Registrations',
      headline: 'Free dish registrations',
      summaryLine: '',
      ...(await reportScope(prisma, orgId, typeof branchId === 'string' ? branchId : undefined)),
      periodLabel: '',
      dateLine: dateLineFor(fromDate, toDate, rows.map((r) => r.createdAt)),
      generatedAt: new Date().toISOString(),
      kpis: [
        { label: 'Registrations', value: rows.length, format: 'integer' },
        { label: 'Free dishes given', value: redeemedCount, format: 'integer', hint: rows.length ? `${Math.round((redeemedCount / rows.length) * 100)}% of registrations` : undefined },
        { label: 'Not yet collected', value: rows.filter((r) => r.state === 'issued').length, format: 'integer' },
      ],
      sections: [{
        type: 'table', id: 'registrations', title: 'Registrations', register: true, primary: true,
        columns: [
          { key: 'createdAt', label: 'Registered', format: 'datetime', width: 1.25 },
          { key: 'name', label: 'Name', width: 1.6 },
          { key: 'whatsapp', label: 'WhatsApp', width: 1.25 },
          { key: 'country', label: 'Country', width: 0.6 },
          { key: 'dateOfBirth', label: 'Date of birth', format: 'date', width: 1 },
          { key: 'email', label: 'Email', width: 1.9 },
          { key: 'where', label: 'Branch / Section', width: 1.6 },
          { key: 'status', label: 'Status', width: 0.8 },
          { key: 'redeemedAt', label: 'Given on', format: 'datetime', width: 1.25 },
        ],
        rows: rows.map((r): ReportRow => ({ ...r, createdAt: r.createdAt.toISOString(), dateOfBirth: r.dateOfBirth.toISOString(), redeemedAt: r.redeemedAt?.toISOString() ?? null, where: `${r.branchName} / ${r.sectionName}`, status: r.state === 'redeemed' ? 'Given' : r.state === 'expired' ? 'Expired' : 'Not collected' })),
        emptyMessage: 'No registrations for the selected filters',
      }],
    }
    report.periodLabel = plural(rows.length, 'registration')
    return sendProReport(res, format, report)
  }

  const { page, limit } = parsePageParams(req.query)
  const [rows, total, summaryRows] = await Promise.all([
    prisma.freeDishSubmission.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...paginate(page, limit) }),
    prisma.freeDishSubmission.count({ where }),
    // summary ignores the status filter so the cards always add up
    prisma.freeDishSubmission.findMany({
      where: { organizationId: orgId, ...(branchId && { branchId }), ...(qrId && { qrId }) },
      select: { status: true, expiresAt: true, createdAt: true, redeemedAt: true },
    }),
  ])
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  res.json({
    ...paginatedResponse(rows.map(shape), total, page, limit),
    summary: {
      registrations: summaryRows.length,
      redeemed: summaryRows.filter((s) => s.status === 'redeemed').length,
      pending: summaryRows.filter((s) => s.status === 'issued' && !isExpired(s)).length,
      expired: summaryRows.filter((s) => s.status === 'issued' && isExpired(s)).length,
      registeredToday: summaryRows.filter((s) => s.createdAt >= startOfToday).length,
      redeemedToday: summaryRows.filter((s) => s.redeemedAt && s.redeemedAt >= startOfToday).length,
    },
  })
})

// ── Scan station: verify a voucher, then give the dish
async function findVoucherForStaff(req: Request, raw: string) {
  const code = extractVoucherCode(raw)
  if (!code) throw new AppError('That is not a Free Dish voucher QR', 404, 'NOT_A_VOUCHER')
  const v = await prisma.freeDishSubmission.findFirst({ where: { voucherCode: code, organizationId: req.user.organizationId }, include: voucherInclude })
  if (!v) throw new AppError(`No voucher found for ${code}`, 404, 'NOT_FOUND')
  return v
}

async function staffView(req: Request, v: VoucherWithQr) {
  const scope = await getBranchScope(req)
  const redeemer = v.redeemedBy ? await prisma.user.findUnique({ where: { id: v.redeemedBy }, select: { firstName: true, lastName: true } }) : null
  return {
    id: v.id,
    code: v.voucherCode,
    name: v.name,
    whatsapp: v.whatsapp,
    email: v.email,
    country: v.country,
    dateOfBirth: v.dateOfBirth,
    offer: v.qr.offer,
    qrName: v.qr.name,
    branchId: v.branchId,
    branchName: v.qr.branch.name,
    sectionId: v.sectionId,
    sectionName: v.qr.section.name,
    statement: voucherStatement(v.qr.branch.name, v.qr.section.name),
    state: voucherState(v),
    otherBranch: scope.restricted && !scope.branchIds.includes(v.branchId),
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    redeemedAt: v.redeemedAt,
    redeemedByName: redeemer ? `${redeemer.firstName} ${redeemer.lastName}`.trim() : null,
  }
}

router.post('/verify', requirePermission(PERM_REDEEM), async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim().min(1).max(500) }).parse(req.body)
  const v = await findVoucherForStaff(req, code)
  res.json({ voucher: await staffView(req, v) })
})

router.post('/redeem', requirePermission(PERM_REDEEM), async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim().min(1).max(500) }).parse(req.body)
  const v = await findVoucherForStaff(req, code)
  await assertBranchAccess(req, v.branchId)
  if (v.status === 'redeemed') throw new AppError('This free dish has already been given', 409, 'ALREADY_REDEEMED')
  if (isExpired(v)) throw new AppError('This voucher has expired', 410, 'EXPIRED')
  // Conditional update: two scanners redeeming the same voucher at once can't both win
  const done = await prisma.freeDishSubmission.updateMany({
    where: { id: v.id, status: 'issued' },
    data: { status: 'redeemed', redeemedAt: new Date(), redeemedBy: req.user.id },
  })
  if (done.count === 0) throw new AppError('This free dish has already been given', 409, 'ALREADY_REDEEMED')
  await logAudit(prisma, { req, action: 'free_dish.redeemed', module: 'free_dish', resourceType: 'FreeDishSubmission', resourceId: v.id, resourceRef: v.voucherCode, branchId: v.branchId })
  const fresh = await prisma.freeDishSubmission.findUniqueOrThrow({ where: { id: v.id }, include: voucherInclude })
  res.json({ voucher: await staffView(req, fresh) })
})

export default router
