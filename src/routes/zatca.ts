import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission, requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { issueForOrder, onboardDevice, publicDevice, reportDocument, reportDue, VAT_NUMBER } from '../services/zatca'
import { assertBranchAccess, getBranchScope } from '../utils/branchScope'

// Settings → ZATCA e-invoicing: seller details, per-branch onboarding and the
// document reporting queue
const router = Router()
router.use(authenticate)

const canView = requireAnyPermission('can_manage_settings', 'can_view_financial_reports')
const canManage = requirePermission('can_manage_settings')

// GET /zatca — settings, devices and queue counts
router.get('/', canView, async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const [org, branches, devices, counts] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, vatNumber: true, crNumber: true, zatcaEnabled: true, country: true, timezone: true, currency: true } }),
    prisma.branch.findMany({ where: { organizationId: orgId, isActive: true }, select: { id: true, name: true, code: true, vatRate: true }, orderBy: { name: 'asc' } }),
    prisma.zatcaDevice.findMany({ where: { organizationId: orgId } }),
    prisma.zatcaDocument.groupBy({ by: ['status'], where: { organizationId: orgId }, _count: true }),
  ])
  res.json({
    settings: org,
    branches: branches.map((b) => ({ ...b, devices: devices.filter((d) => d.branchId === b.id).map(publicDevice), device: devices.find((d) => d.branchId === b.id) ? publicDevice(devices.find((d) => d.branchId === b.id)!) : null })),
    queue: Object.fromEntries(counts.map((c) => [c.status, c._count])),
  })
})

// PUT /zatca/settings
router.put('/settings', canManage, async (req: Request, res: Response) => {
  const body = z.object({
    zatcaEnabled: z.boolean().optional(),
    vatNumber: z.string().trim().regex(VAT_NUMBER, 'VAT registration number is 15 digits and starts and ends with 3').optional(),
    crNumber: z.string().trim().regex(/^\d{10}$/, 'Commercial registration number is 10 digits').optional(),
  }).parse(req.body)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  if (body.zatcaEnabled) {
    const vat = body.vatNumber ?? org.vatNumber
    const cr = body.crNumber ?? org.crNumber
    if (!vat || !VAT_NUMBER.test(vat) || !cr) throw new AppError('Enter the VAT registration number and CR number before switching e-invoicing on', 400, 'ZATCA_SETUP')
  }
  const updated = await prisma.organization.update({ where: { id: org.id }, data: body, select: { vatNumber: true, crNumber: true, zatcaEnabled: true } })
  await logAudit(prisma, { req, action: 'update', module: 'settings', resourceType: 'zatca', resourceId: org.id, resourceRef: 'ZATCA settings', newData: body })
  res.json(updated)
})

// POST /zatca/devices — onboard a branch (OTP from the Fatoora portal)
router.post('/devices', canManage, async (req: Request, res: Response) => {
  const body = z.object({
    branchId: z.string().min(1),
    counterCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,30}$/).default('main'),
    environment: z.enum(['sandbox', 'simulation', 'production']),
    otp: z.string().trim().regex(/^\d{6}$/, 'The OTP from the Fatoora portal is 6 digits'),
    street: z.string().trim().min(2).max(120),
    building: z.string().trim(),
    district: z.string().trim().min(2).max(80),
    city: z.string().trim().min(2).max(80),
    postalCode: z.string().trim(),
    industry: z.string().trim().max(60).optional(),
  }).parse(req.body)
  const result = await onboardDevice({ ...body, organizationId: req.user.organizationId })
  await logAudit(prisma, { req, action: 'create', module: 'settings', resourceType: 'zatca_device', resourceId: result.device.id, resourceRef: `ZATCA ${body.environment}`, branchId: body.branchId, newData: { environment: body.environment } })
  res.status(201).json(result)
})

// GET /zatca/documents?status=&branchId=&page=
router.get('/documents', canView, async (req: Request, res: Response) => {
  const { status, branchId, page = '1' } = req.query as Record<string, string>
  const where = { organizationId: req.user.organizationId, ...(status && { status }), ...(branchId && { branchId }) }
  const take = 50
  const skip = (Math.max(1, Number(page) || 1) - 1) * take
  const [rows, total] = await Promise.all([
    prisma.zatcaDocument.findMany({
      where, orderBy: { createdAt: 'desc' }, take, skip,
      select: { id: true, type: true, invoiceNo: true, icv: true, branchId: true, orderId: true, issuedAt: true, totalAmount: true, vatAmount: true, status: true, attempts: true, response: true, reportedAt: true },
    }),
    prisma.zatcaDocument.count({ where }),
  ])
  res.json({ data: rows, total, page: Number(page) || 1, totalPages: Math.ceil(total / take) })
})

// GET /zatca/documents/:id/xml — the signed XML as sent to ZATCA
router.get('/documents/:id/xml', canView, async (req: Request, res: Response) => {
  const doc = await prisma.zatcaDocument.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!doc) throw new AppError('Document not found', 404, 'NOT_FOUND')
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${doc.invoiceNo}.xml"`)
  res.send(doc.xml)
})

// POST /zatca/documents/:id/report — report now (failed or pending)
router.post('/documents/:id/report', canManage, async (req: Request, res: Response) => {
  const doc = await prisma.zatcaDocument.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!doc) throw new AppError('Document not found', 404, 'NOT_FOUND')
  res.json(await reportDocument(doc.id))
})

// ── Documents that were never issued ─────────────────────────────────────────
// Issuance runs after the sale commits (POS, offline sync, COD delivery), so a
// failure there leaves a paid order without its e-invoice. These are listed
// here and can be issued again; issuing only creates the signed document.

// a branch device issues for orders paid after it became active
function activeSince(device: { createdAt: Date; onboardingLog: unknown }) {
  const log = Array.isArray(device.onboardingLog) ? device.onboardingLog as { ok?: boolean; at?: string }[] : []
  const at = log.filter((l) => l.ok && l.at).map((l) => Date.parse(l.at!)).filter(Number.isFinite)
  return new Date(at.length ? Math.max(...at) : device.createdAt.getTime())
}

export async function unissuedDocuments(organizationId: string, branchIds?: string[]) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { zatcaEnabled: true } })
  if (!org.zatcaEnabled) return []
  const devices = await prisma.zatcaDevice.findMany({ where: { organizationId, status: 'active', ...(branchIds && { branchId: { in: branchIds } }) } })
  const select = { id: true, orderNo: true, branchId: true, source: true, orderType: true, closedAt: true, totalAmount: true, status: true } as const
  const rows = await Promise.all(devices.map(async (d) => {
    const since = activeSince(d), base = { organizationId, branchId: d.branchId, counterCode: d.counterCode, closedAt: { gte: since }, items: { some: { status: { not: 'cancelled' } } } }
    const [invoices, credits] = await Promise.all([
      prisma.customerOrder.findMany({ where: { ...base, checks: { none: {} }, status: 'completed', zatcaDocuments: { none: { type: 'invoice' } } }, select, orderBy: { closedAt: 'asc' }, take: 100 }),
      prisma.customerOrder.findMany({ where: { organizationId, branchId: d.branchId, checks: { none: {} }, status: 'refunded', AND: [{ zatcaDocuments: { some: { type: 'invoice', deviceId: d.id } } }, { zatcaDocuments: { none: { type: 'credit' } } }] }, select, orderBy: { closedAt: 'asc' }, take: 100 }),
    ])
    const checks = await prisma.orderCheck.findMany({ where: { organizationId, branchId: d.branchId, counterCode: d.counterCode, paidAt: { gte: since }, status: { in: ['paid', 'refunded'] }, OR: [{ zatcaDocuments: { none: { type: 'invoice' } } }, { status: 'refunded', zatcaDocuments: { none: { type: 'credit' } } }] }, include: { order: { select }, zatcaDocuments: { select: { type: true } } }, orderBy: { paidAt: 'asc' }, take: 100 })
    return [...invoices.map((o) => ({ ...o, type: 'invoice' as const })), ...credits.map((o) => ({ ...o, type: 'credit' as const })), ...checks.flatMap((c) => {
      const info = { ...c.order, checkId: c.id, checkLabel: c.label, totalAmount: c.totalAmount, closedAt: c.paidAt }
      return [...(!c.zatcaDocuments.some((d) => d.type === 'invoice') ? [{ ...info, type: 'invoice' as const }] : []), ...(c.status === 'refunded' && !c.zatcaDocuments.some((d) => d.type === 'credit') ? [{ ...info, type: 'credit' as const }] : [])]
    })]
  }))
  return rows.flat()
}

// GET /zatca/unissued — paid orders missing their invoice, refunds missing their credit note
router.get('/unissued', canView, async (req: Request, res: Response) => {
  const scope = await getBranchScope(req)
  res.json({ data: await unissuedDocuments(req.user.organizationId, scope.restricted ? scope.branchIds : undefined) })
})

// POST /zatca/orders/:id/issue — issue a missing document now (idempotent)
router.post('/orders/:id/issue', canManage, async (req: Request, res: Response) => {
  const { type, checkId } = z.object({ type: z.enum(['invoice', 'credit']).default('invoice'), checkId: z.string().min(1).optional() }).parse(req.body ?? {})
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, select: { id: true, branchId: true, orderNo: true, status: true, cancelReason: true } })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  if (!checkId && (type === 'invoice' ? order.status !== 'completed' && order.status !== 'refunded' : order.status !== 'refunded')) throw new AppError(type === 'invoice' ? 'Only paid orders get an e-invoice' : 'Only refunded orders get a credit note', 409, 'INVALID_STATUS')
  if (checkId && type === 'credit') await issueForOrder(order.id, 'invoice', undefined, checkId)
  const doc = await issueForOrder(order.id, type, order.cancelReason ?? undefined, checkId).catch((e: unknown) => {
    throw new AppError(`The e-invoice could not be issued: ${e instanceof Error ? e.message : String(e)}`, 502, 'ZATCA_ISSUE_FAILED')
  })
  if (!doc) throw new AppError('E-invoicing is not active for this branch, or this order has nothing to invoice', 409, 'ZATCA_NOT_ELIGIBLE')
  await logAudit(prisma, { req, action: 'zatca_issue_retry', module: 'settings', resourceType: 'customer_order', resourceId: order.id, resourceRef: `#${order.orderNo}`, branchId: order.branchId, newData: { type, documentId: doc.id } })
  res.json(doc)
})

// POST /zatca/report-due — run the queue now
router.post('/report-due', canManage, async (_req: Request, res: Response) => {
  res.json({ processed: await reportDue() })
})

export default router
