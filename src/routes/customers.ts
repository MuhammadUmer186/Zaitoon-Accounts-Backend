import { validMoneyPrecision } from '../utils/money'
import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { formatContextFor, formatDateTime } from '../utils/reportFormat'
import { ProReport, sendProReport } from '../utils/proReport'
import { normalizePhone } from '../services/deliveryPricing'
import { customerForPhone } from '../services/customers'
import { loyaltyConfig } from '../services/tenders'
import { RECEIPT_METHODS, takeReceipt } from '../services/customerReceipts'
import { callWallet, flushBranchWallets, payHouseAccountAtBranch } from '../services/branchWallets'

// Customers (one per phone number per organization): history, visits and
// spend, loyalty points and house accounts. Shared by POS, online ordering
// and the call centre.
const router = Router()
router.use(authenticate, async (req: Request, _res: Response, next: NextFunction) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
})
const view = requireAnyPermission('can_manage_customers', 'can_manage_orders', 'can_use_pos', 'can_take_call_center_orders')
const manage = requirePermission('can_manage_customers')
const round2 = (n: number) => regionalRoundMoney(n)
const money = z.number().finite().positive().max(10000000).refine((n) => validMoneyPrecision(n), "Use the selected currency decimal precision")
const orderSummary = { id: true, orderNo: true, status: true, orderType: true, source: true, totalAmount: true, createdAt: true, closedAt: true, branchId: true, items: { where: { status: { not: 'cancelled' } }, select: { dishId: true, dishName: true, quantity: true, selection: true, notes: true } } } as const

async function findCustomer(req: Request) {
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!customer) throw new AppError('Customer not found', 404, 'NOT_FOUND')
  return customer
}
async function loyaltyView(organizationId: string, points: number) {
  const config = await loyaltyConfig(prisma as never, organizationId)
  return { active: config.active, points: round2(points), value: round2(points * config.pointValue), pointValue: config.pointValue, earnPerUnit: config.earnPerUnit }
}

// GET /customers?search=&page=
router.get('/', view, async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query)
  const search = String(req.query.search ?? '').trim()
  const where = { organizationId: req.user.organizationId, ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: search.replace(/[^\d+]/g, '') || search } }, { email: { contains: search, mode: 'insensitive' as const } }] }) }
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }], ...paginate(page, limit), select: { id: true, name: true, phone: true, email: true, tags: true, visitCount: true, totalSpend: true, lastVisitAt: true, loyaltyPoints: true, houseAccountEnabled: true, houseBalance: true, creditLimit: true } }),
    prisma.customer.count({ where }),
  ])
  res.json(paginatedResponse(rows, total, page, limit))
})

// GET /customers/lookup?phone= — POS / call centre: who is calling, what they had
router.get('/lookup', view, async (req: Request, res: Response) => {
  const { phone } = z.object({ phone: z.string().min(7).max(30) }).parse(req.query)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { id: true, country: true } })
  const normalized = normalizePhone(phone, org.country)
  const customer = await prisma.customer.findUnique({ where: { organizationId_phone: { organizationId: org.id, phone: normalized } } })
  if (!customer) return res.json({ customer: null, phone: normalized })
  const branch = await branchFilter(req)
  const recentOrders = await prisma.customerOrder.findMany({ where: { organizationId: org.id, customerId: customer.id, ...(branch && { branchId: branch }) }, orderBy: { createdAt: 'desc' }, take: 5, select: orderSummary })
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const central = await callWallet('view', { actorId: req.user.id, phone: normalized }) as unknown as { customer: { loyaltyPoints: number; houseAccountEnabled: boolean; houseBalance: number; creditLimit: number } | null; loyalty: { active: boolean; pointValue: number; earnPerUnit: number } }
      const wallet = central.customer ?? { loyaltyPoints: 0, houseAccountEnabled: false, houseBalance: 0, creditLimit: 0 }
      res.json({ customer: { ...customer, ...wallet }, recentOrders, phone: normalized, walletPolicy: 'online-only', walletOnline: true, loyalty: { ...central.loyalty, points: wallet.loyaltyPoints, value: round2(wallet.loyaltyPoints * central.loyalty.pointValue) }, houseAvailable: wallet.houseAccountEnabled ? round2(wallet.creditLimit - wallet.houseBalance) : 0 }); return
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SHARED_WALLET_OFFLINE') throw error
      res.json({ customer: { ...customer, loyaltyPoints: 0, houseAccountEnabled: false, houseBalance: 0, creditLimit: 0 }, recentOrders, phone: normalized, walletPolicy: 'online-only', walletOnline: false, loyalty: { active: false, points: 0, value: 0, pointValue: 0, earnPerUnit: 0 }, houseAvailable: 0 }); return
    }
  }
  res.json({ customer, recentOrders, phone: normalized, loyalty: await loyaltyView(org.id, customer.loyaltyPoints), houseAvailable: customer.houseAccountEnabled ? round2(customer.creditLimit - customer.houseBalance) : 0 })
})

// POST /customers — add (or find) the customer for a phone number at the till
router.post('/', view, async (req: Request, res: Response) => {
  const b = z.object({ phone: z.string().trim().min(7).max(30).regex(/^\+?[0-9 ()-]+$/), name: z.string().trim().min(1).max(60), email: z.string().trim().email().max(120).optional().nullable() }).parse(req.body)
  const customer = await prisma.$transaction(async (tx) => {
    const c = await customerForPhone(tx, req.user.organizationId, b.phone, b.name)
    return b.email && !c.email ? tx.customer.update({ where: { id: c.id }, data: { email: b.email } }) : c
  })
  res.status(201).json(customer)
})

// GET /customers/:id — profile, history, loyalty, house account, gift cards
router.get('/:id', view, async (req: Request, res: Response) => {
  const customer = await findCustomer(req)
  const branch = await branchFilter(req)
  const [orders, loyalty, house, giftCards] = await Promise.all([
    prisma.customerOrder.findMany({ where: { organizationId: req.user.organizationId, customerId: customer.id, ...(branch && { branchId: branch }) }, orderBy: { createdAt: 'desc' }, take: 20, select: orderSummary }),
    prisma.loyaltyTransaction.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.houseAccountTransaction.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.giftCard.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'desc' }, select: { id: true, code: true, balance: true, initialAmount: true, status: true, expiresAt: true } }),
  ])
  res.json({ customer, orders, loyaltyTransactions: loyalty, houseTransactions: house, giftCards, loyalty: await loyaltyView(req.user.organizationId, customer.loyaltyPoints) })
})

// PUT /customers/:id — profile, notes (allergies), tags and house account
router.put('/:id', manage, async (req: Request, res: Response) => {
  const b = z.object({
    name: z.string().trim().min(1).max(60), email: z.string().trim().email().max(120).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]), houseAccountEnabled: z.boolean().default(false), creditLimit: z.number().finite().min(0).max(100000000).default(0),
  }).parse(req.body)
  const old = await findCustomer(req)
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${old.id} FOR UPDATE`
    const saved = await tx.customer.update({ where: { id: old.id }, data: { ...b, tags: [...new Set(b.tags.map((t) => t.toLowerCase()))] } })
    await logAudit(tx, { req, action: 'update_customer', module: 'customers', resourceType: 'customer', resourceId: old.id, resourceRef: old.phone, oldData: { houseAccountEnabled: old.houseAccountEnabled, creditLimit: old.creditLimit, tags: old.tags }, newData: { houseAccountEnabled: b.houseAccountEnabled, creditLimit: b.creditLimit, tags: saved.tags } })
    return saved
  })
  res.json(updated)
})

// POST /customers/:id/payments — the customer settles (part of) their house account
router.post('/:id/payments', requireAnyPermission('can_manage_customers', 'can_manage_orders'), async (req: Request, res: Response) => {
  const b = z.object({ requestId: z.string().uuid(), branchId: z.string().min(1), amount: money, method: z.enum(RECEIPT_METHODS) }).parse(req.body)
  const customer = await findCustomer(req)
  await assertBranchAccess(req, b.branchId)
  if (!await prisma.branch.count({ where: { id: b.branchId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    // The central balance is authoritative (online only); it falls once the
    // cloud confirms this PC recorded the money.
    const paid = await payHouseAccountAtBranch(req, customer.id, { requestId: b.requestId, method: b.method, amount: b.amount })
    void flushBranchWallets().catch(() => undefined)
    res.status(paid.duplicate ? 200 : 201).json({ receipt: paid.receipt, duplicate: paid.duplicate, pendingCentralConfirmation: true })
    return
  }
  const result = await prisma.$transaction(async (tx) => {
    const previous = await tx.customerReceipt.findUnique({ where: { organizationId_requestId: { organizationId: req.user.organizationId, requestId: b.requestId } } })
    if (!previous) {
      await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customer.id} FOR UPDATE`
      const fresh = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } })
      if (b.amount > round2(fresh.houseBalance) + 0.0001) throw new AppError(`The account balance is ${round2(fresh.houseBalance)}`, 409, 'OVERPAYMENT')
    }
    const { receipt, duplicate } = await takeReceipt(tx, req, { branchId: b.branchId, type: 'house_account_payment', method: b.method, amount: b.amount, requestId: b.requestId, customerId: customer.id, credit: 'ACCOUNTS_RECEIVABLE', description: `House account payment - ${customer.name}` })
    if (!duplicate) {
      const fresh = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } })
      const balanceAfter = round2(fresh.houseBalance - b.amount)
      await tx.customer.update({ where: { id: customer.id }, data: { houseBalance: balanceAfter } })
      await tx.houseAccountTransaction.create({ data: { organizationId: req.user.organizationId, customerId: customer.id, type: 'payment', amount: -b.amount, balanceAfter, receiptId: receipt.id, referenceKey: `payment:${receipt.id}`, userId: req.user.id } })
      await logAudit(tx, { req, action: 'house_account_payment', module: 'customers', resourceType: 'customer', resourceId: customer.id, branchId: b.branchId, newData: { amount: b.amount, method: b.method, receiptId: receipt.id } })
    }
    return { receipt, duplicate, customer: await tx.customer.findUniqueOrThrow({ where: { id: customer.id } }) }
  })
  res.status(result.duplicate ? 200 : 201).json(result)
})

// GET /customers/:id/statement?format= — house account statement
router.get('/:id/statement', view, async (req: Request, res: Response) => {
  const customer = await findCustomer(req)
  const [org, ctx, rows] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { name: true, currency: true } }),
    formatContextFor(req.user.organizationId, req.user.id),
    prisma.houseAccountTransaction.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
  ])
  const orderNos = new Map((await prisma.customerOrder.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => !!x) } }, select: { id: true, orderNo: true } })).map((o) => [o.id, o.orderNo]))
  const label = { charge: 'Charged to account', reverse_charge: 'Refund of a charge', payment: 'Payment received' } as Record<string, string>
  const charges = round2(rows.filter((r) => r.amount > 0).reduce((n, r) => n + r.amount, 0)), credits = round2(-rows.filter((r) => r.amount < 0).reduce((n, r) => n + r.amount, 0))
  const report: ProReport = {
    key: 'house-account-statement', eyebrow: 'HOUSE ACCOUNT STATEMENT', headline: customer.name, orgName: org.name, currency: org.currency,
    scopeLabel: customer.phone, periodLabel: `To ${formatDateTime(new Date(), ctx)}`, generatedAt: new Date().toISOString(),
    summaryLine: `Credit limit ${round2(customer.creditLimit)}  |  ${customer.houseAccountEnabled ? 'Account open' : 'Account closed'}`,
    kpis: [{ label: 'Charged', value: charges, format: 'money' }, { label: 'Paid / refunded', value: credits, format: 'money' }, { label: 'Balance owed', value: round2(customer.houseBalance), format: 'money' }],
    sections: [{ type: 'table', id: 'transactions', title: 'Account activity', columns: [{ key: 'date', label: 'Date' }, { key: 'detail', label: 'Detail' }, { key: 'amount', label: 'Amount', format: 'money' }, { key: 'balance', label: 'Balance', format: 'money' }],
      rows: rows.map((r) => ({ date: formatDateTime(r.createdAt, ctx), detail: `${label[r.type] ?? r.type}${r.orderId && orderNos.get(r.orderId) ? ` · order #${orderNos.get(r.orderId)}` : ''}`, amount: r.amount, balance: r.balanceAfter })) }],
  }
  await sendProReport(res, String(req.query.format || 'json'), report)
})

export default router
