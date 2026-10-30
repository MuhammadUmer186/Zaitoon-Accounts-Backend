import { validMoneyPrecision } from '../utils/money'
import { Router, Request } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { rateLimit } from '../middleware/rateLimit'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { sendProReport, ProReport } from '../utils/proReport'
import { withReportFormat, momentRange } from '../utils/reportFormat'
import { AppError } from '../middleware/error'
import { ACTION_PERMISSIONS, createApproval, pinLookup, authorizePos } from '../services/posSecurity'
import { blindSession, canManageTills, lockCashier, round2, tillReport, tillTotals } from '../services/tills'

const router = Router()
router.use(authenticate)
router.use(requireAnyPermission('can_use_pos', 'can_manage_tills'))
const pin = z.string().regex(/^\d{4,6}$/, 'PIN must contain 4–6 digits')
const money = z.number().finite().min(0).max(100000000).refine((n) => validMoneyPrecision(n), "Use the selected currency decimal precision")
async function sessionFor(req: Request, id: string) {
  const s = await prisma.tillSession.findFirst({ where: { id, organizationId: req.user.organizationId } })
  if (!s) throw new AppError('Till session not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, s.branchId)
  if (s.userId !== req.user.id && !await canManageTills(prisma, req)) throw new AppError('This is another cashier’s till', 403, 'FORBIDDEN')
  return s
}

router.put('/users/:id/pin', requirePermission('can_manage_users'), async (req, res) => {
  const body = z.object({ pin: pin.nullable() }).parse(req.body)
  const u = await prisma.user.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!u) throw new AppError('User not found', 404, 'NOT_FOUND')
  const hash = body.pin ? await bcrypt.hash(body.pin, 12) : null
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: u.id }, data: { posPin: hash, posPinLookup: body.pin ? pinLookup(u.organizationId, body.pin) : null } })
    await logAudit(tx, { req, action: 'set_pos_pin', module: 'users', resourceType: 'user', resourceId: u.id, newData: { enabled: !!body.pin } })
  }).catch((e) => { if (e.code === 'P2002') throw new AppError('This PIN is already in use', 409, 'PIN_IN_USE'); throw e })
  res.json({ enabled: !!body.pin })
})

router.post('/authorize', rateLimit('pos-authorize', 5, 60000), async (req, res) => {
  const b = z.object({ branchId: z.string().min(1), pin, action: z.enum(['discount', 'void', 'refund', 'drawer']), resourceId: z.string().min(1) }).parse(req.body)
  await assertBranchAccess(req, b.branchId)
  const branch = await prisma.branch.findFirst({ where: { id: b.branchId, organizationId: req.user.organizationId, isActive: true } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  const result = await createApproval(req, b.branchId, b.pin, b.action, b.resourceId)
  await logAudit(prisma, { req, action: 'pos_authorization', module: 'pos', branchId: b.branchId, resourceId: b.resourceId, newData: { action: b.action, approvedBy: result.approvedBy } })
  res.json(result)
})

router.get('/void-reasons', async (req, res) => {
  for (const name of ['Wrong item', 'Guest changed mind', 'Kitchen error', 'Quality issue', 'Other']) await prisma.voidReason.upsert({ where: { organizationId_name: { organizationId: req.user.organizationId, name } }, create: { organizationId: req.user.organizationId, name }, update: {} })
  res.json({ data: await prisma.voidReason.findMany({ where: { organizationId: req.user.organizationId, isActive: true }, orderBy: { name: 'asc' } }) })
})
router.post('/void-reasons', requirePermission('can_manage_tills'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body)
  const reason = await prisma.voidReason.create({ data: { organizationId: req.user.organizationId, ...b } })
  await logAudit(prisma, { req, action: 'create_void_reason', module: 'pos', resourceId: reason.id, newData: b })
  res.status(201).json(reason)
})

// rename or retire a reason (retired defaults are not re-created)
router.put('/void-reasons/:id', requirePermission('can_manage_tills'), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(60).optional(), isActive: z.boolean().optional() }).parse(req.body)
  const existing = await prisma.voidReason.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!existing) throw new AppError('Void reason not found', 404, 'NOT_FOUND')
  if (existing.name === 'Other' && (b.isActive === false || (b.name && b.name !== 'Other'))) throw new AppError('"Other" is always available so staff can explain an unusual case', 400, 'VALIDATION_ERROR')
  const reason = await prisma.voidReason.update({ where: { id: existing.id }, data: b }).catch((e) => { if (e.code === 'P2002') throw new AppError('A reason with that name exists', 409, 'DUPLICATE'); throw e })
  await logAudit(prisma, { req, action: 'update_void_reason', module: 'pos', resourceId: reason.id, newData: b })
  res.json(reason)
})

// all reasons including retired ones, for the settings screen
router.get('/void-reasons/all', requirePermission('can_manage_tills'), async (req, res) => {
  res.json({ data: await prisma.voidReason.findMany({ where: { organizationId: req.user.organizationId }, orderBy: { name: 'asc' } }) })
})

router.get('/tills', async (req, res) => {
  const branch = await branchFilter(req, String(req.query.branchId || '') || undefined)
  const manage = await canManageTills(prisma, req)
  const sessions = await prisma.tillSession.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }), ...(!manage && { userId: req.user.id }) }, orderBy: { openedAt: 'desc' }, take: 100 })
  res.json({ data: sessions.map(blindSession) })
})

router.post('/tills', async (req, res) => {
  const b = z.object({ branchId: z.string().min(1), openingFloat: money, deviceName: z.string().trim().max(80).optional(), notes: z.string().trim().max(500).optional() }).parse(req.body)
  await assertBranchAccess(req, b.branchId)
  const branch = await prisma.branch.findFirst({ where: { id: b.branchId, organizationId: req.user.organizationId, isActive: true } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  const s = await prisma.$transaction(async (tx) => {
    await lockCashier(tx, b.branchId, req.user.id)
    if (await tx.tillSession.count({ where: { branchId: b.branchId, userId: req.user.id, status: 'open' } })) throw new AppError('You already have an open till at this branch', 409, 'TILL_ALREADY_OPEN')
    const result = await tx.tillSession.create({ data: { ...b, organizationId: req.user.organizationId, userId: req.user.id } })
    await logAudit(tx, { req, action: 'open_till', module: 'pos', branchId: b.branchId, resourceId: result.id, newData: b })
    return result
  })
  res.status(201).json(blindSession(s))
})

router.post('/tills/:id/movements', async (req, res) => {
  const b = z.object({ type: z.enum(['pay_in', 'pay_out', 'drop']), amount: money.refine((n) => n > 0), reason: z.string().trim().min(3).max(200), approvalToken: z.string().optional() }).parse(req.body)
  const s = await sessionFor(req, req.params.id)
  const movement = await prisma.$transaction(async (tx) => {
    await lockCashier(tx, s.branchId, s.userId)
    const fresh = await tx.tillSession.findUniqueOrThrow({ where: { id: s.id } })
    if (fresh.status !== 'open') throw new AppError('This till is closed', 409, 'TILL_CLOSED')
    const approvedBy = await authorizePos(tx, req, 'drawer', s.branchId, s.id, b.approvalToken)
    const result = await tx.tillMovement.create({ data: { sessionId: s.id, type: b.type, amount: b.amount, reason: b.reason, userId: req.user.id } })
    await logAudit(tx, { req, action: 'till_movement', module: 'pos', branchId: s.branchId, resourceId: s.id, newData: { type: b.type, amount: b.amount, reason: b.reason, approvedBy } })
    return result
  })
  res.status(201).json(movement)
})

router.post('/tills/:id/drawer', async (req, res) => {
  const b = z.object({ reason: z.string().trim().min(3).max(200), approvalToken: z.string().optional() }).parse(req.body)
  const s = await sessionFor(req, req.params.id)
  await prisma.$transaction(async (tx) => {
    await lockCashier(tx, s.branchId, s.userId)
    if ((await tx.tillSession.findUniqueOrThrow({ where: { id: s.id } })).status !== 'open') throw new AppError('Till is closed', 409, 'TILL_CLOSED')
    const approvedBy = await authorizePos(tx, req, 'drawer', s.branchId, s.id, b.approvalToken)
    await logAudit(tx, { req, action: 'open_drawer', module: 'pos', branchId: s.branchId, resourceId: s.id, newData: { reason: b.reason, approvedBy } })
  })
  res.json({ authorized: true })
})

router.post('/tills/:id/close', async (req, res) => {
  const b = z.object({ countedCash: money, notes: z.string().trim().max(500).optional() }).parse(req.body)
  const s = await sessionFor(req, req.params.id)
  const closed = await prisma.$transaction(async (tx) => {
    await lockCashier(tx, s.branchId, s.userId)
    if ((await tx.tillSession.findUniqueOrThrow({ where: { id: s.id } })).status !== 'open') throw new AppError('Till already closed', 409, 'TILL_CLOSED')
    const totals = await tillTotals(tx, s.id)
    const result = await tx.tillSession.update({ where: { id: s.id }, data: { status: 'closed', closedAt: new Date(), countedCash: b.countedCash, expectedCash: totals.expectedCash, difference: round2(b.countedCash - totals.expectedCash), ...(b.notes && { notes: b.notes }) } })
    await tx.$queryRaw`SELECT id FROM "Branch" WHERE id = ${s.branchId} FOR UPDATE`
    const last = await tx.zReport.aggregate({ where: { branchId: s.branchId }, _max: { number: true } })
    const number = (last._max.number ?? 0) + 1
    const report = await tillReport(tx, s.id, number)
    const zReport = await tx.zReport.create({ data: { organizationId: s.organizationId, branchId: s.branchId, sessionId: s.id, number, report: report as unknown as Prisma.InputJsonValue } })
    await logAudit(tx, { req, action: 'close_till', module: 'pos', branchId: s.branchId, resourceId: s.id, newData: { countedCash: b.countedCash, expectedCash: totals.expectedCash, difference: result.difference, zNumber: number } })
    return { ...result, zReport }
  })
  res.json(closed)
})

router.get('/tills/:id/report', withReportFormat, async (req, res) => {
  const s = await sessionFor(req, req.params.id)
  const z = await prisma.zReport.findUnique({ where: { sessionId: s.id } })
  if (!z && !await canManageTills(prisma, req)) throw new AppError('Only a manager can see expected cash before the blind close', 403, 'BLIND_COUNT')
  const report = z ? z.report as unknown as ProReport : await tillReport(prisma, s.id)
  await sendProReport(res, req.query.format as string, report, { zNumber: z?.number })
})

// A daily close still uses Daily Sales for cash; sessions reconcile drawer movements.
router.get('/till-reconciliation', requireAnyPermission('can_manage_tills', 'can_create_cash_closing'), async (req, res) => {
  const b = z.object({ branchId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query)
  await assertBranchAccess(req, b.branchId)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const range = momentRange(b.date, b.date, { ...org, decimals: 2, dateFormat: org.dateFormat as import('../utils/regions').DateFormat })
  const sessions = await prisma.tillSession.findMany({ where: { organizationId: org.id, branchId: b.branchId, status: 'closed', closedAt: range }, include: { movements: true } })
  res.json({ data: sessions, openingCash: round2(sessions.reduce((n, s) => n + s.openingFloat, 0)), actualCashCounted: round2(sessions.reduce((n, s) => n + (s.countedCash ?? 0), 0)), otherCashIn: round2(sessions.flatMap((s) => s.movements).filter((m) => m.type === 'pay_in').reduce((n, m) => n + m.amount, 0)), otherCashOut: round2(sessions.flatMap((s) => s.movements).filter((m) => m.type === 'pay_out').reduce((n, m) => n + m.amount, 0)), cashDeposited: round2(sessions.flatMap((s) => s.movements).filter((m) => m.type === 'drop').reduce((n, m) => n + m.amount, 0)) })
})

export default router
