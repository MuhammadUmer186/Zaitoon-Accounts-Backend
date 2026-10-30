import { roundMoney as regionalRoundMoney } from '../utils/money'
import crypto from 'node:crypto'
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { RECEIPT_METHODS, takeReceipt } from '../services/customerReceipts'
import { giftCardByCode } from '../services/tenders'
import { callWallet, flushBranchWallets, sellGiftCardAtBranch } from '../services/branchWallets'

// Gift cards: sold at the till (a liability, not revenue), checked at the
// till and spent as a payment at checkout (services/tenders).
const router = Router()
router.use(authenticate, async (req: Request, _res: Response, next: NextFunction) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
})
const sell = requireAnyPermission('can_manage_orders', 'can_manage_customers')
const view = requireAnyPermission('can_manage_orders', 'can_use_pos', 'can_manage_customers')
const round2 = (n: number) => regionalRoundMoney(n)
// no 0/O/1/I so a code read aloud or typed from paper is not mistaken
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newCode = () => 'GC-' + Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('').replace(/(.{4})(.{4})/, '$1-$2')
const publicCard = (c: { id: string; code: string; balance: number; initialAmount: number; status: string; expiresAt: Date | null; customerId: string | null; createdAt: Date }) =>
  ({ id: c.id, code: c.code, balance: round2(c.balance), initialAmount: c.initialAmount, status: c.status, expiresAt: c.expiresAt, customerId: c.customerId, createdAt: c.createdAt, usable: c.status === 'active' && (!c.expiresAt || c.expiresAt > new Date()) && c.balance > 0 })

// POST /gift-cards — sell a gift card
router.post('/', sell, async (req: Request, res: Response) => {
  const b = z.object({
    requestId: z.string().uuid(), branchId: z.string().min(1), method: z.enum(RECEIPT_METHODS),
    amount: z.number().finite().min(1).max(100000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.00001, 'Use two decimal places'),
    customerId: z.string().min(1).optional().nullable(), expiresAt: z.string().datetime().optional().nullable(),
  }).parse(req.body)
  await assertBranchAccess(req, b.branchId)
  if (!await prisma.branch.count({ where: { id: b.branchId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (b.customerId && !await prisma.customer.count({ where: { id: b.customerId, organizationId: req.user.organizationId } })) throw new AppError('Customer not found', 404, 'NOT_FOUND')
  if (b.expiresAt && new Date(b.expiresAt) <= new Date()) throw new AppError('Choose an expiry date in the future', 400, 'VALIDATION_ERROR')
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    // The card is created centrally (online only) and becomes spendable once
    // the cloud confirms this PC recorded the payment.
    const sold = await sellGiftCardAtBranch(req, { requestId: b.requestId, method: b.method, amount: b.amount, customerId: b.customerId ?? null, expiresAt: b.expiresAt ?? null })
    void flushBranchWallets().catch(() => undefined)
    res.status(sold.duplicate ? 200 : 201).json({ code: sold.code, balance: round2(sold.amount), initialAmount: sold.amount, status: 'pending', usable: false, duplicate: sold.duplicate, message: 'The card activates as soon as the cloud confirms this sale (normally within seconds).' })
    return
  }
  const result = await prisma.$transaction(async (tx) => {
    const previous = await tx.customerReceipt.findUnique({ where: { organizationId_requestId: { organizationId: req.user.organizationId, requestId: b.requestId } } })
    if (previous) {
      // a retried sale returns the card it already created
      await takeReceipt(tx, req, { branchId: b.branchId, type: 'gift_card_sale', method: b.method, amount: b.amount, requestId: b.requestId, customerId: b.customerId, credit: 'GIFT_CARD_LIABILITY', description: 'Gift card sold' })
      return { card: await tx.giftCard.findUniqueOrThrow({ where: { id: previous.giftCardId! } }), duplicate: true }
    }
    let code = newCode()
    while (await tx.giftCard.count({ where: { organizationId: req.user.organizationId, code } })) code = newCode()
    const card = await tx.giftCard.create({ data: { organizationId: req.user.organizationId, code, customerId: b.customerId ?? null, initialAmount: b.amount, balance: b.amount, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null, issuedBranchId: b.branchId, createdBy: req.user.id } })
    const { receipt } = await takeReceipt(tx, req, { branchId: b.branchId, type: 'gift_card_sale', method: b.method, amount: b.amount, requestId: b.requestId, customerId: b.customerId, giftCardId: card.id, credit: 'GIFT_CARD_LIABILITY', description: `Gift card sold ${code}` })
    await tx.giftCardTransaction.create({ data: { organizationId: req.user.organizationId, giftCardId: card.id, type: 'issue', amount: b.amount, balanceAfter: b.amount, receiptId: receipt.id, referenceKey: `issue:${card.id}`, userId: req.user.id } })
    await logAudit(tx, { req, action: 'sell_gift_card', module: 'customers', resourceType: 'gift_card', resourceId: card.id, resourceRef: code, branchId: b.branchId, newData: { amount: b.amount, method: b.method } })
    return { card, duplicate: false }
  })
  res.status(result.duplicate ? 200 : 201).json({ ...publicCard(result.card), duplicate: result.duplicate })
})

// GET /gift-cards/lookup?code= — balance at the till
router.get('/lookup', view, async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim().min(4).max(40) }).parse(req.query)
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    const result = await callWallet('view', { actorId: req.user.id, giftCardCode: code }) as unknown as { card: Parameters<typeof publicCard>[0] | null }
    if (!result.card) throw new AppError('Gift card not found', 404, 'GIFT_CARD_NOT_FOUND')
    res.setHeader('Cache-Control', 'no-store')
    res.json(publicCard({ ...result.card, expiresAt: result.card.expiresAt ? new Date(result.card.expiresAt) : null })); return
  }
  const card = await giftCardByCode(prisma as never, req.user.organizationId, code)
  if (!card) throw new AppError('Gift card not found', 404, 'GIFT_CARD_NOT_FOUND')
  res.json(publicCard(card))
})

// GET /gift-cards?page= — cards and the outstanding liability
router.get('/', view, async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query)
  const where = { organizationId: req.user.organizationId }
  const [rows, total, outstanding] = await Promise.all([
    prisma.giftCard.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(page, limit) }),
    prisma.giftCard.count({ where }),
    prisma.giftCard.aggregate({ where: { ...where, status: 'active' }, _sum: { balance: true } }),
  ])
  res.json({ ...paginatedResponse(rows.map(publicCard), total, page, limit), outstanding: round2(outstanding._sum.balance ?? 0) })
})

// GET /gift-cards/:id/transactions — the card's history
router.get('/:id/transactions', view, async (req: Request, res: Response) => {
  const card = await prisma.giftCard.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!card) throw new AppError('Gift card not found', 404, 'NOT_FOUND')
  res.json({ card: publicCard(card), transactions: await prisma.giftCardTransaction.findMany({ where: { giftCardId: card.id }, orderBy: { createdAt: 'asc' } }) })
})

export default router
