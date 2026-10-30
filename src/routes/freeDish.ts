import { Router, Request } from 'express'
import { randomBytes, createHash } from 'crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission, requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { businessDay, dayBoundary, normalizeGuest, parseVoucher, voucherCode, voucherState } from '../utils/freeDish'
import { sendRowsCsv, sendRowsExcel } from '../utils/genericExport'
import PDFDocument from 'pdfkit'
import { resolveUpload } from '../middleware/imageUpload'
import { branchFreeDish } from '../services/branchFreeDish'

export const freeDishRouter = Router(), publicFreeDishRouter = Router()
const manage = requirePermission('free_dish_manage'), redeem = requirePermission('free_dish_redeem')
const either = requireAnyPermission('free_dish_manage', 'free_dish_redeem')
const missing = () => new AppError('Voucher or offer not found', 404, 'NOT_FOUND')
const itemSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(200).nullable().optional(), isActive: z.boolean().default(true) })
const offerSchema = z.object({ name: z.string().trim().min(1).max(120), branchId: z.string().min(1), sectionId: z.string().min(1), itemId: z.string().min(1), quantity: z.number().int().min(1).max(20).default(1), voucherValidDays: z.number().int().min(1).max(365).nullable().default(null), isActive: z.boolean().default(true) })
const publicVoucher = (v: any) => ({ firstName: v.fullName.split(/\s+/)[0], voucherCode: v.voucherCode, itemName: v.itemName, quantity: v.quantity, branchName: v.branchName, sectionName: v.sectionName, createdAt: v.createdAt, expiresAt: v.expiresAt, redeemedAt: v.redeemedAt, state: voucherState(v) })
const offerInclude = { branch: true, section: true, item: true, organization: true } as const
function branding(org: any, logoRoute: string) { return { businessName: org.tradeName || org.name, logoUrl: org.logoPath ? `/public/free-dish${logoRoute}/logo` : org.logoUrl, defaultCountry: org.country, timezone: org.timezone, privacyNotice: process.env.FREE_DISH_PRIVACY_NOTICE || null, privacyUrl: process.env.PRIVACY_NOTICE_URL || null } }
publicFreeDishRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next() })
publicFreeDishRouter.use(async (req, res, next) => { if (!await branchFreeDish(req, res, true)) next() })
publicFreeDishRouter.get('/qr/:token', async (req, res) => {
  const q = await prisma.freeDishQr.findUnique({ where: { publicToken: req.params.token }, include: offerInclude })
  if (!q || !q.organization.isActive) throw missing()
  res.json({ ...branding(q.organization, `/qr/${q.publicToken}`), name: q.name, itemName: q.item.name, quantity: q.quantity, branchName: q.branch.name, sectionName: q.section.name, isActive: q.isActive && q.branch.isActive })
})
publicFreeDishRouter.get('/voucher/:code', async (req, res) => {
  const v = await prisma.freeDishSubmission.findUnique({ where: { voucherCode: parseVoucher(req.params.code) }, include: { organization: true } })
  if (!v || !v.organization.isActive) throw missing()
  res.json({ ...publicVoucher(v), ...branding(v.organization, `/voucher/${v.voucherCode}`) })
})
for (const resource of ['qr', 'voucher']) publicFreeDishRouter.get(`/${resource}/:key/logo`, async (req, res) => {
  const record = resource === 'qr' ? await prisma.freeDishQr.findUnique({ where: { publicToken: req.params.key }, include: { organization: true } }) : await prisma.freeDishSubmission.findUnique({ where: { voucherCode: parseVoucher(req.params.key) }, include: { organization: true } })
  if (!record?.organization.isActive || !record.organization.logoPath) throw missing()
  const file = resolveUpload(record.organization.logoPath)
  if (!file) throw missing()
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.sendFile(file)
})
publicFreeDishRouter.post('/qr/:token/submit', async (req, res) => {
  // Atomic shared fixed-window bucket; no raw guest IP is persisted.
  const now = new Date(), window = Math.floor(+now / 3600000)
  const key = createHash('sha256').update(`${req.ip}:${window}`).digest('hex')
  const bucket = await prisma.freeDishRateLimit.upsert({ where: { key }, create: { key, attempts: 1, expiresAt: new Date((window + 1) * 3600000) }, update: { attempts: { increment: 1 } } })
  if (bucket.attempts > Math.max(1, Number(process.env.FREE_DISH_RATE_LIMIT) || 30)) { res.setHeader('Retry-After', Math.ceil((+bucket.expiresAt - +now) / 1000)); throw new AppError('Too many attempts. Try again later.', 429, 'TOO_MANY_ATTEMPTS') }
  await prisma.freeDishRateLimit.deleteMany({ where: { expiresAt: { lt: now } } })
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const v = await prisma.$transaction(async tx => {
        // Offer row lock also serializes edits/closure and duplicate submissions.
        const q0 = await tx.freeDishQr.findUnique({ where: { publicToken: req.params.token } })
        if (!q0) throw missing()
        await tx.$queryRaw`SELECT id FROM "FreeDishQr" WHERE id = ${q0.id} FOR UPDATE`
        const q = await tx.freeDishQr.findUniqueOrThrow({ where: { id: q0.id }, include: offerInclude })
        await tx.$queryRaw`SELECT id FROM "Branch" WHERE id = ${q.branchId} FOR SHARE`
        const branch = await tx.branch.findUniqueOrThrow({ where: { id: q.branchId } })
        if (!q.isActive || !branch.isActive || !q.organization.isActive) throw new AppError('This offer is closed', 409, 'OFFER_CLOSED')
        const b = normalizeGuest(req.body, businessDay(new Date(), q.organization.timezone))
        const [phone, email] = await Promise.all([
          tx.freeDishSubmission.findUnique({ where: { qrId_normalizedWhatsApp: { qrId: q.id, normalizedWhatsApp: b.normalizedWhatsApp } } }),
          tx.freeDishSubmission.findUnique({ where: { qrId_normalizedEmail: { qrId: q.id, normalizedEmail: b.normalizedEmail } } }),
        ])
        if (email && email.id !== phone?.id) throw new AppError('This email already belongs to another number for this offer', 409, 'DUPLICATE_EMAIL')
        if (phone) return phone
        const issuedAt = new Date()
        return tx.freeDishSubmission.create({ data: { ...b, organizationId: q.organizationId, qrId: q.id, branchId: q.branchId, sectionId: q.sectionId, itemName: q.item.name, quantity: q.quantity, branchName: q.branch.name, sectionName: q.section.name, voucherCode: voucherCode(), createdAt: issuedAt, expiresAt: q.voucherValidDays ? new Date(+issuedAt + q.voucherValidDays * 86400000) : null } })
      })
      res.json(publicVoucher(v)); return
    } catch (e: any) { if (!['P2002', 'P2034'].includes(e.code) || attempt === 4) throw e }
  }
})
freeDishRouter.use(authenticate, async (req, res, next) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  res.setHeader('Cache-Control', 'no-store'); next()
})
freeDishRouter.use(async (req, res, next) => { if (!await branchFreeDish(req, res, false)) next() })
freeDishRouter.get('/sections', either, async (req, res) => {
  const branchId = await branchFilter(req, req.query.branchId as string)
  const where = { organizationId: req.user.organizationId, ...(branchId && { branchId }) }
  res.json({ sections: await prisma.branchSection.findMany({ where, orderBy: { name: 'asc' } }), branches: await prisma.branch.findMany({ where: { organizationId: req.user.organizationId, ...(branchId && { id: branchId }) }, select: { id: true, name: true, isActive: true } }) })
})
freeDishRouter.post('/sections', manage, async (req, res) => {
  const b = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(80) }).parse(req.body)
  await assertBranchAccess(req, b.branchId)
  if (!await prisma.branch.count({ where: { id: b.branchId, organizationId: req.user.organizationId } })) throw missing()
  const section = await prisma.$transaction(async tx => { const s = await tx.branchSection.create({ data: { ...b, organizationId: req.user.organizationId } }); await logAudit(tx, { req, action: 'create_section', module: 'free_dish', resourceId: s.id, branchId: b.branchId }); return s })
  res.status(201).json(section)
})
freeDishRouter.get('/items', manage, async (req, res) => {
  const branchId = await branchFilter(req)
  res.json({ data: await prisma.freeDishItem.findMany({ where: { organizationId: req.user.organizationId }, include: { _count: { select: { offers: { where: branchId ? { branchId } : {} } } } }, orderBy: { name: 'asc' } }) })
})
for (const method of ['post', 'put', 'delete'] as const) freeDishRouter[method](method === 'post' ? '/items' : '/items/:id', manage, async (req, res) => {
  const result = await prisma.$transaction(async tx => {
    const old = method === 'post' ? null : await tx.freeDishItem.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
    if (method !== 'post' && !old) throw missing()
    const b = method === 'delete' ? null : itemSchema.parse(req.body)
    const item = method === 'post' ? await tx.freeDishItem.create({ data: { ...b!, organizationId: req.user.organizationId } }) : method === 'put' ? await tx.freeDishItem.update({ where: { id: old!.id }, data: b! }) : await tx.freeDishQr.count({ where: { itemId: old!.id } }) ? await tx.freeDishItem.update({ where: { id: old!.id }, data: { isActive: false } }) : await tx.freeDishItem.delete({ where: { id: old!.id } })
    await logAudit(tx, { req, action: `${method}_free_item`, module: 'free_dish', resourceId: item.id }); return item
  }); res.json(result)
})
freeDishRouter.get('/qr-codes', manage, async (req, res) => {
  const where = { organizationId: req.user.organizationId, branchId: await branchFilter(req, req.query.branchId as string) }
  const [data, counts] = await Promise.all([
    prisma.freeDishQr.findMany({ where, include: { branch: true, section: true, item: true, _count: { select: { submissions: true } } }, orderBy: { createdAt: 'desc' } }),
    prisma.freeDishSubmission.groupBy({ by: ['qrId'], where: { ...where, status: 'redeemed' }, _count: true }),
  ])
  res.json({ data: data.map(q => ({ ...q, redeemedCount: counts.find(c => c.qrId === q.id)?._count || 0 })) })
})
for (const method of ['post', 'put', 'delete'] as const) freeDishRouter[method](method === 'post' ? '/qr-codes' : '/qr-codes/:id', manage, async (req, res) => {
  const result = await prisma.$transaction(async tx => {
    let old = null
    if (method !== 'post') {
      await tx.$queryRaw`SELECT id FROM "FreeDishQr" WHERE id = ${req.params.id} AND "organizationId" = ${req.user.organizationId} FOR UPDATE`
      old = await tx.freeDishQr.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, include: { _count: { select: { submissions: true } } } })
      if (!old) throw missing(); await assertBranchAccess(req, old.branchId)
    }
    let q
    if (method === 'delete') q = old!._count.submissions ? await tx.freeDishQr.update({ where: { id: old!.id }, data: { isActive: false } }) : await tx.freeDishQr.delete({ where: { id: old!.id } })
    else {
      const b = offerSchema.parse(req.body); await assertBranchAccess(req, b.branchId)
      if (old?._count.submissions && ['branchId', 'sectionId', 'itemId', 'quantity'].some(k => (old as any)[k] !== (b as any)[k])) throw new AppError('Create a new QR to change branch, section, item or quantity after registration', 409, 'QR_IN_USE')
      const [branch, section, item] = await Promise.all([tx.branch.findFirst({ where: { id: b.branchId, organizationId: req.user.organizationId } }), tx.branchSection.findFirst({ where: { id: b.sectionId, organizationId: req.user.organizationId, branchId: b.branchId } }), tx.freeDishItem.findFirst({ where: { id: b.itemId, organizationId: req.user.organizationId } })])
      if (!branch || !section || !item || ((!old || old.itemId !== item.id) && !item.isActive)) throw new AppError('Select an active item and a section belonging to this branch', 400, 'VALIDATION_ERROR')
      q = old ? await tx.freeDishQr.update({ where: { id: old.id }, data: b }) : await tx.freeDishQr.create({ data: { ...b, organizationId: req.user.organizationId, createdBy: req.user.id, publicToken: randomBytes(32).toString('hex') } })
    }
    await logAudit(tx, { req, action: `${method}_free_dish_qr`, module: 'free_dish', resourceId: q.id, branchId: q.branchId }); return q
  }); res.json(result)
})
async function staffVoucher(req: Request, tx: Prisma.TransactionClient = prisma) {
  const { input } = z.object({ input: z.string().trim().min(1).max(500) }).parse(req.body)
  const record = await tx.freeDishSubmission.findFirst({ where: { voucherCode: parseVoucher(input), organizationId: req.user.organizationId }, include: { organization: { select: { timezone: true } } } })
  if (!record) throw missing()
  const { organization, ...v } = record
  try { await assertBranchAccess(req, v.branchId) } catch (e) {
    if (e instanceof AppError && e.code === 'BRANCH_FORBIDDEN') throw new AppError(`Please collect at ${v.branchName} · ${v.sectionName}. This voucher is outside your branch access.`, 403, 'BRANCH_FORBIDDEN')
    throw e
  }
  const user = v.redeemedBy ? await tx.user.findUnique({ where: { id: v.redeemedBy }, select: { firstName: true, lastName: true } }) : null
  return { ...v, timezone: organization.timezone, state: voucherState(v), redeemedByName: user ? `${user.firstName} ${user.lastName}` : null }
}
freeDishRouter.post('/verify', redeem, async (req, res) => { res.json(await staffVoucher(req)) })
freeDishRouter.post('/redeem', redeem, async (req, res) => {
  const v = await prisma.$transaction(async tx => {
    const candidate = await staffVoucher(req, tx)
    // Acquire the row before checking time: an UPDATE predicate can be evaluated
    // before waiting on an unchanged row's lock, even with clock_timestamp().
    await tx.$queryRaw`SELECT id FROM "FreeDishSubmission" WHERE id = ${candidate.id} FOR UPDATE`
    const v = await staffVoucher(req, tx)
    if (v.state === 'redeemed') throw new AppError('Voucher has already been redeemed', 409, 'ALREADY_REDEEMED')
    if (v.state === 'expired') throw new AppError('Voucher has expired', 409, 'EXPIRED')
    // The lock is already held; compare UTC timestamps at mutation as well.
    const changed = await tx.$executeRaw`UPDATE "FreeDishSubmission" SET status = 'redeemed', "redeemedAt" = (clock_timestamp() AT TIME ZONE 'UTC'), "redeemedBy" = ${req.user.id} WHERE id = ${v.id} AND status = 'issued' AND ("expiresAt" IS NULL OR "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))`
    if (!changed) { const current = await tx.freeDishSubmission.findUniqueOrThrow({ where: { id: v.id } }); throw new AppError(current.status === 'redeemed' ? 'Voucher has already been redeemed' : 'Voucher has expired', 409, current.status === 'redeemed' ? 'ALREADY_REDEEMED' : 'EXPIRED') }
    await logAudit(tx, { req, action: 'redeem_free_dish', module: 'free_dish', resourceType: 'free_dish_submission', resourceId: v.id, branchId: v.branchId, newData: { quantity: v.quantity, voucherCode: v.voucherCode } })
    return staffVoucher(req, tx)
  }); res.json(v)
})
freeDishRouter.get('/submissions', manage, async (req, res) => {
  const query = z.object({ branchId: z.string().optional(), qrId: z.string().optional(), search: z.string().max(160).optional(), status: z.enum(['waiting', 'redeemed', 'expired']).optional(), from: z.string().optional(), to: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), format: z.enum(['csv', 'excel', 'pdf']).optional() }).parse(req.query)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } }), now = new Date()
  const nextDay = (d: string) => { dayBoundary(d, org.timezone); return new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10) }
  if (query.from && query.to && query.from > query.to) throw new AppError('End date must follow start date', 400, 'VALIDATION_ERROR')
  const where: Prisma.FreeDishSubmissionWhereInput = { organizationId: org.id, branchId: await branchFilter(req, query.branchId), qrId: query.qrId, ...(query.from || query.to ? { createdAt: { ...(query.from && { gte: dayBoundary(query.from, org.timezone) }), ...(query.to && { lt: dayBoundary(nextDay(query.to), org.timezone) }) } } : {}) }
  if (query.search) { const search = query.search.trim(), phone = search.replace(/\D/g, ''); where.OR = ['fullName', 'normalizedEmail', 'voucherCode'].map(k => ({ [k]: { contains: search, mode: 'insensitive' } })); if (phone) where.OR.push({ normalizedWhatsApp: { contains: phone.replace(/^0+/, '') || phone } }) }
  const statusWhere = (status: string): Prisma.FreeDishSubmissionWhereInput => status === 'redeemed' ? { status: 'redeemed' } : status === 'expired' ? { status: 'issued', expiresAt: { lte: now } } : { status: 'issued', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
  const filtered = { AND: [where, query.status ? statusWhere(query.status) : {}] }
  if (query.format) {
    const records = await prisma.freeDishSubmission.findMany({ where: filtered, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const rows = records.map(v => ({ registeredAt: v.createdAt.toISOString(), guest: v.fullName, whatsapp: v.normalizedWhatsApp, country: v.country, dateOfBirth: v.dateOfBirth.toISOString().slice(0, 10), email: v.normalizedEmail, voucher: v.voucherCode, item: v.itemName, quantity: v.quantity, branch: v.branchName, section: v.sectionName, status: voucherState(v), redeemedAt: v.redeemedAt?.toISOString() || '' }))
    // Neutralize spreadsheet formula injection in guest-supplied cells.
    const safeRows = rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^[=+@\-\t\r]/.test(v) ? `'${v}` : v])))
    if (query.format === 'csv') return sendRowsCsv(res, safeRows, 'free-dish')
    if (query.format === 'excel') return sendRowsExcel(res, safeRows, 'free-dish')
    res.type('pdf').attachment('free-dish.pdf')
    const doc = new PDFDocument({ margin: 36 }); doc.pipe(res)
    doc.fontSize(18).text(`${org.tradeName || org.name} — Free Dish registrations`)
    for (const row of rows) { if (doc.y > 590) doc.addPage(); doc.moveDown().fontSize(10); for (const [k, v] of Object.entries(row)) doc.text(`${k}: ${v}`) }
    doc.end(); return
  }
  const today = dayBoundary(businessDay(now, org.timezone), org.timezone)
  const count = (extra: Prisma.FreeDishSubmissionWhereInput) => prisma.freeDishSubmission.count({ where: { AND: [where, extra] } })
  const [data, total, registrations, redeemedVouchers, waiting, expired, registeredToday, redeemedToday, units] = await prisma.$transaction([
    prisma.freeDishSubmission.findMany({ where: filtered, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.freeDishSubmission.count({ where: filtered }), count({}), count(statusWhere('redeemed')), count(statusWhere('waiting')), count(statusWhere('expired')), count({ createdAt: { gte: today } }), count({ redeemedAt: { gte: today }, status: 'redeemed' }), prisma.freeDishSubmission.aggregate({ where: { AND: [where, { status: 'redeemed' }] }, _sum: { quantity: true } }),
  ])
  res.json({ data: data.map(v => ({ ...v, state: voucherState(v, now) })), total, page: query.page, pageSize: query.pageSize, metrics: { registrations, redeemedVouchers, waiting, expired, registeredToday, redeemedToday, itemUnitsGiven: units._sum.quantity || 0 }, timezone: org.timezone, summaryNote: 'Status filter applies to the table only. Other filters apply to both table and summaries.' })
})
