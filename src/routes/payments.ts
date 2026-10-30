import { roundMoney as regionalRoundMoney } from '../utils/money'

import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { rateLimit } from '../middleware/rateLimit'
import { logAudit } from '../utils/audit'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { adapterFor, adapterOptions, signSimulatorEvent } from '../services/payments/adapters'
import { createIntent, handleCallback, intentByToken, paymentStatus, publicIntent, refundReviewedIntent, refreshProviderIntent } from '../services/payments'

// Staff side of payment integrations: status, card-terminal payments from
// the POS, the list of online payments and resolving the ones that could not
// be applied.
const router = Router()
router.use(authenticate, async (req: Request, _res: Response, next: NextFunction) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
})
const cashier = requireAnyPermission('can_manage_orders', 'can_use_pos')
const manage = requirePermission('can_manage_payments')

const statusView = async (organizationId: string) => { const { context, ...s } = await paymentStatus(prisma, organizationId); void context; return { ...s, options: adapterOptions() } }
router.get('/status', cashier, async (req: Request, res: Response) => res.json(await statusView(req.user.organizationId)))

// POST /payments/terminal — send the bill (or one check) to the card terminal
router.post('/terminal', cashier, async (req: Request, res: Response) => {
  const b = z.object({ counterCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,30}$/).optional(), orderId: z.string().min(1), checkId: z.string().min(1).optional().nullable() }).parse(req.body)
  const order = await prisma.customerOrder.findFirst({ where: { id: b.orderId, organizationId: req.user.organizationId } })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  const { intent, accessToken } = await createIntent({ organizationId: order.organizationId, branchId: order.branchId, orderId: order.id, checkId: b.checkId ?? null, channel: 'terminal', createdBy: req.user.id, counterCode: b.counterCode })
  await logAudit(prisma, { req, action: 'terminal_payment_started', module: 'payments', resourceType: 'payment_intent', resourceId: intent.id, branchId: order.branchId, newData: { orderId: order.id, checkId: b.checkId ?? null, amount: intent.amount } })
  res.status(201).json({ ...publicIntent(intent), accessToken })
})

// GET /payments/:id/state — the POS waits for the terminal
router.get('/:id/state', cashier, async (req: Request, res: Response) => {
  const intent = await prisma.paymentIntent.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!intent) throw new AppError('Payment not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, intent.branchId)
  res.json(publicIntent(await refreshProviderIntent(intent)))
})

// POST /payments/:id/cancel — stop waiting (only before the gateway answered)
router.post('/:id/cancel', cashier, async (req: Request, res: Response) => {
  const intent = await prisma.paymentIntent.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!intent) throw new AppError('Payment not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, intent.branchId)
  const r = await prisma.paymentIntent.updateMany({ where: { id: intent.id, status: { in: ['created', 'pending'] } }, data: { status: 'cancelled', failureReason: 'Cancelled at the till' } })
  if (!r.count) throw new AppError('This payment already has an answer from the gateway', 409, 'INVALID_STATUS')
  res.json(publicIntent(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })))
})

// GET /payments?status=&page= — online and terminal payments
router.get('/', manage, async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query)
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined
  const branch = await branchFilter(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined)
  const where = { organizationId: req.user.organizationId, ...(branch && { branchId: branch }), ...(status === 'attention' ? { OR: [{ status: 'needs_review' }, { refundStatus: { in: ['failed', 'pending'] } }] } : status ? { status } : {}) }
  const [rows, total, summary] = await Promise.all([
    prisma.paymentIntent.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(page, limit), include: { events: { orderBy: { createdAt: 'asc' }, select: { type: true, outcome: true, signatureValid: true, createdAt: true } } } }),
    prisma.paymentIntent.count({ where }),
    prisma.paymentIntent.groupBy({ by: ['status'], where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }, _sum: { amount: true }, _count: true }),
  ])
  const orders = new Map((await prisma.customerOrder.findMany({ where: { id: { in: rows.map((r) => r.orderId) } }, select: { id: true, orderNo: true } })).map((o) => [o.id, o.orderNo]))
  res.json({ ...paginatedResponse(rows.map(({ accessTokenHash, idempotencyKey, ...r }) => { void accessTokenHash; void idempotencyKey; return { ...r, orderNo: orders.get(r.orderId) ?? null } }), total, page, limit), summary: summary.map((s) => ({ status: s.status, count: s._count, amount: regionalRoundMoney(s._sum.amount ?? 0) })) })
})

// POST /payments/:id/refund — return a payment that could not be applied
router.post('/:id/refund', manage, async (req: Request, res: Response) => {
  const intent = await prisma.paymentIntent.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!intent) throw new AppError('Payment not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, intent.branchId)
  res.json(publicIntent(await refundReviewedIntent(req, intent.id)))
})

export default router

// ── Callbacks from integrations (no login; verified by the adapter) ─────────
export const callbackRouter = Router()
callbackRouter.post('/:adapter', rateLimit('payment-callback', 600, 60_000), async (req: Request, res: Response) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody
  if (!raw) throw new AppError('Empty callback', 400, 'INVALID_PAYLOAD')
  const result = await handleCallback(req.params.adapter, { ...req.headers, 'x-foodsync-organization': String(req.query.organizationId ?? '') }, raw)
  res.json({ received: true, outcome: result.outcome })
})

// ── Public: the payer's view of one payment, and the sandbox simulator ──────
export const publicPaymentsRouter = Router()
publicPaymentsRouter.get('/:id', rateLimit('payment-view', 240, 60_000), async (req: Request, res: Response) => {
  const intent = await refreshProviderIntent(await intentByToken(req.params.id, String(req.query.t ?? '')))
  const [org, order] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: intent.organizationId }, select: { name: true, tradeName: true } }),
    prisma.customerOrder.findUniqueOrThrow({ where: { id: intent.orderId }, select: { orderNo: true } }),
  ])
  res.setHeader('Cache-Control', 'no-store')
  res.json({ ...publicIntent(intent), merchant: org.tradeName || org.name, orderNo: order.orderNo, simulator: intent.adapter === 'simulator' })
})

// POST /public/payments/:id/simulate — the simulator's "card page" / "card
// tap": builds a signed callback and sends it through the normal callback
// verification. Sandbox simulator only; refuses anything else.
publicPaymentsRouter.post('/:id/simulate', rateLimit('payment-simulate', 30, 60_000), async (req: Request, res: Response) => {
  const { t, outcome } = z.object({ t: z.string().min(10), outcome: z.enum(['approve', 'decline']) }).parse(req.body)
  const intent = await intentByToken(req.params.id, t)
  if (intent.adapter !== 'simulator' || intent.environment !== 'sandbox' || !adapterFor('simulator')) throw new AppError('Not a sandbox payment', 409, 'NOT_SANDBOX')
  if (!['created', 'pending'].includes(intent.status)) return res.json({ ...publicIntent(intent) })
  if (intent.expiresAt < new Date()) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'expired' } })
    throw new AppError('This payment link has expired', 409, 'EXPIRED')
  }
  const body = JSON.stringify({ eventId: `sim_evt_${crypto.randomUUID()}`, type: outcome === 'approve' ? 'payment.succeeded' : 'payment.failed', providerRef: intent.providerRef, organizationId: intent.organizationId, amount: intent.amount, currency: intent.currency, merchantId: intent.merchantId, ...(outcome === 'decline' && { reason: 'Card declined (simulated)' }) })
  await handleCallback('simulator', signSimulatorEvent(intent.organizationId, body), Buffer.from(body))
  res.json(publicIntent(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })))
})
