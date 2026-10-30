import { roundMoney as regionalRoundMoney } from '../utils/money'

import { Router } from 'express'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { assertBranchAccess, getBranchScope } from '../utils/branchScope'
import { prisma } from '../config'
import { branchTokenHash, receiveBranchEvents } from '../services/branchSync'
import { exportBranch } from '../services/branchProvisioning'
import { getUserPermissions } from '../utils/permissions'
import { Request } from 'express'
import { AppError } from '../middleware/error'
import { beginReplica, receiveReplicaPart, commitReplica, cancelReplica, replicaHead } from '../services/branchReplicaTransport'
import { claimOnlineCommands, completeOnlineCommand } from '../services/branchOnline'
import { cloudBranchAlerts } from '../services/branchHealth'
import { readBranchMedia, writeBranchMedia } from '../services/branchMedia'
import { branchRefund } from '../services/branchPayments'
import { reserveWallet, resolveWallet, pendingWallets, earnBranchWallet, walletView, applyHoldResolution } from '../services/branchWallets'
import { cloudFreeDish } from '../services/branchFreeDish'
import { startStockTransfer, receiveStockTransfer, transferView, cancelStockTransfer } from '../services/branchTransfers'

const router = Router()
const replicaToken = (value?: string) => {
  const token = value?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
  if (!token) throw new AppError('Branch credentials required', 401, 'BRANCH_UNAUTHORIZED')
  return token
}
// Inventory decision, not a settings one: inventory managers cancel and return goods that never arrived.
router.post('/transfers/:id/cancel', authenticate, requirePermission('can_manage_inventory'), async (req, res) => { res.json(await cancelStockTransfer(req, req.params.id, req.body)) })
router.post('/transfers/start', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await startStockTransfer(replicaToken(req.headers.authorization), req.body)) })
router.post('/transfers/view', async (req, res) => { const body = z.object({ actorId: z.string().min(1) }).strict().parse(req.body); res.setHeader('Cache-Control', 'no-store'); res.json(await transferView(replicaToken(req.headers.authorization), body.actorId)) })
router.post('/transfers/receive', async (req, res) => { const body = z.object({ transferId: z.string().uuid(), actorId: z.string().min(1), confirmPhysicalReceipt: z.literal(true) }).strict().parse(req.body); res.setHeader('Cache-Control', 'no-store'); res.json(await receiveStockTransfer(replicaToken(req.headers.authorization), body.transferId, { actorId: body.actorId, confirmPhysicalReceipt: body.confirmPhysicalReceipt })) })
router.post('/free-dish', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await cloudFreeDish(replicaToken(req.headers.authorization), req.body, req.socket.localPort!)) })
router.post('/free-dish/public', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await cloudFreeDish(replicaToken(req.headers.authorization), req.body, req.socket.localPort!, true)) })
router.post('/wallets/reserve', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await reserveWallet(replicaToken(req.headers.authorization), req.body)) })
router.post('/wallets/resolve', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await resolveWallet(replicaToken(req.headers.authorization), req.body, req.headers['x-wallet-sequence'])) })
router.get('/wallets/pending', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await pendingWallets(replicaToken(req.headers.authorization), req.headers['x-wallet-sequence'])) })
router.post('/wallets/earn', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await earnBranchWallet(replicaToken(req.headers.authorization), req.body, req.headers['x-wallet-sequence'])) })
router.post('/wallets/view', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await walletView(replicaToken(req.headers.authorization), req.body)) })
router.post('/media/read', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await readBranchMedia(prisma, replicaToken(req.headers.authorization), req.body)) })
router.post('/media/write', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await writeBranchMedia(prisma, replicaToken(req.headers.authorization), req.body)) })
router.post('/payments/:id/refund', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await branchRefund(replicaToken(req.headers.authorization), req.params.id)) })
router.get('/replica/head', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await replicaHead(replicaToken(req.headers.authorization))) })
router.post('/replica/begin', async (req, res) => { res.json(await beginReplica(replicaToken(req.headers.authorization), req.body)) })
router.post('/replica/:id/part', async (req, res) => { res.json(await receiveReplicaPart(replicaToken(req.headers.authorization), req.params.id, req.body)) })
router.post('/replica/:id/commit', async (req, res) => { res.json(await commitReplica(replicaToken(req.headers.authorization), req.params.id)) })
router.delete('/replica/:id', async (req, res) => { res.json(await cancelReplica(replicaToken(req.headers.authorization), req.params.id)) })
router.post('/commands/claim', async (req, res) => { res.json(await claimOnlineCommands(replicaToken(req.headers.authorization))) })
router.post('/commands/:id/complete', async (req, res) => {
  const body = z.object({ claimToken: z.string().regex(/^[a-f0-9]{64}$/), status: z.number().int().min(200).max(499), result: z.unknown() }).strict().parse(req.body)
  res.json(await completeOnlineCommand(replicaToken(req.headers.authorization), req.params.id, body))
})
// The PC's final step of a planned handover. Ownership is released only when
// the cloud's acknowledged checkpoint is exactly the PC's final state and no
// online order is still waiting on the PC.
router.post('/handover/complete', async (req, res) => {
  const body = z.object({ revision: z.string().regex(/^\d{1,18}$/), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body)
  const tokenHash = branchTokenHash(replicaToken(req.headers.authorization))
  const result = await prisma.$transaction(async tx => {
    const found = await tx.branchSyncNode.findFirst({ where: { tokenHash, isActive: true, ownsWrites: true } })
    if (!found) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${found.branchId}`}))`
    const node = await tx.branchSyncNode.findUnique({ where: { id: found.id } })
    if (!node?.isActive || !node.ownsWrites || !node.handoverRequestedAt) throw new AppError('No handover was requested for this PC', 409, 'HANDOVER_NOT_REQUESTED')
    if (node.replicaRevision !== BigInt(body.revision) || node.replicaDigest !== body.digest) throw new AppError('The cloud has not acknowledged this PC\'s final checkpoint', 409, 'HANDOVER_NOT_READY')
    if (await tx.branchRemoteCommand.count({ where: { nodeId: node.id, kind: { in: ['online-place', 'payment-settle'] }, status: { in: ['queued', 'claimed'] } } })) throw new AppError('Orders or payments are still waiting on this PC', 409, 'HANDOVER_NOT_READY')
    if (await tx.branchWalletReservation.count({ where: { nodeId: node.id, state: 'reserved' } })) throw new AppError('Shared-wallet reservations require reconciliation before handover', 409, 'HANDOVER_NOT_READY')
    if (await tx.branchStockTransfer.count({ where: { OR: [{ sourceNodeId: node.id }, { destinationNodeId: node.id }], state: { notIn: ['received', 'dispatch_failed'] } } })) throw new AppError('Stock transfers require receipt or reviewed recovery before handover', 409, 'HANDOVER_NOT_READY')
    return tx.branchSyncNode.update({ where: { id: node.id }, data: { ownsWrites: false, isActive: false, releasedAt: new Date(), releaseReason: 'Planned handover completed by the PC after its final checkpoint' } })
  })
  res.json({ released: true, revision: result.replicaRevision.toString() })
})
router.post('/health', async (req, res) => {
  const body = z.object({ alerts: z.array(z.object({ code: z.string().regex(/^[A-Z_]{3,40}$/), severity: z.enum(['warning', 'critical']), message: z.string().max(500) }).strict()).max(50) }).strict().parse(req.body)
  const node = await prisma.branchSyncNode.findFirst({ where: { tokenHash: branchTokenHash(replicaToken(req.headers.authorization)), isActive: true, ownsWrites: true } })
  if (!node) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  await prisma.branchSyncNode.update({ where: { id: node.id }, data: { healthReport: body, healthReportedAt: new Date(), lastSeenAt: new Date() } })
  res.json({ received: true })
})
router.post('/events', async (req, res) => {
  const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
  if (!token) throw new AppError('Branch credentials required', 401, 'BRANCH_UNAUTHORIZED')
  res.json(await receiveBranchEvents(token, req.body))
})
router.get('/configuration', async (req, res) => {
  const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
  if (!token) throw new AppError('Branch credentials required', 401, 'BRANCH_UNAUTHORIZED')
  const node = await prisma.branchSyncNode.findFirst({ where: { tokenHash: branchTokenHash(token), isActive: true, ownsWrites: true } })
  if (!node?.provisionedBy) throw new AppError('Branch administrator enrollment required', 401, 'BRANCH_UNAUTHORIZED')
  const owner = await prisma.user.findFirst({ where: { id: node.provisionedBy, organizationId: node.organizationId, isActive: true, organization: { isActive: true } } })
  if (!owner) throw new AppError('Branch administrator is unavailable', 401, 'BRANCH_UNAUTHORIZED')
  const access = await getUserPermissions(prisma, owner.id)
  if (!['can_manage_settings', 'can_manage_users', 'can_view_financial_reports'].every(key => access.permissions.has(key))) throw new AppError('Branch administrator permissions changed', 403, 'FORBIDDEN')
  const principal = { user: { id: owner.id, organizationId: owner.organizationId, email: owner.email } } as Request
  const data = await exportBranch(principal, node.branchId, false, true)
  res.setHeader('Cache-Control', 'no-store')
  res.json({ ...data, nodeId: node.id, kind: 'branch-configuration' })
})
router.use(authenticate, requirePermission('can_manage_settings'))
router.post('/nodes', requirePermission('can_manage_users'), requirePermission('can_view_financial_reports'), async (req, res) => {
  const body = z.object({ branchId: z.string().min(1), name: z.string().trim().min(1).max(100), includeHr: z.boolean().default(false) }).strict().parse(req.body)
  if (body.includeHr) {
    const permissions = await getUserPermissions(prisma, req.user.id)
    if (!permissions.permissions.has('can_view_hr') || !permissions.permissions.has('can_view_payroll')) throw new AppError('HR and payroll permissions are required', 403, 'FORBIDDEN')
  }
  await assertBranchAccess(req, body.branchId)
  if (!await prisma.branch.count({ where: { id: body.branchId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Active branch not found', 404, 'NOT_FOUND')
  // One active PC per branch. Explicit revocation is required before replacement.
  const token = randomBytes(32).toString('hex')
  const node = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${body.branchId}`}))`
    if (await tx.branchSyncNode.count({ where: { organizationId: req.user.organizationId, branchId: body.branchId, ownsWrites: true } })) throw new AppError('This branch already has a local owner. Complete a reviewed handover before replacing it.', 409, 'BRANCH_ALREADY_ENROLLED')
    const where = { organizationId: req.user.organizationId, branchId: body.branchId }
    const blockers = await Promise.all([
      tx.customerOrder.count({ where: { ...where, status: { notIn: ['completed', 'cancelled', 'refunded', 'rejected'] } } }),
      tx.tillSession.count({ where: { ...where, status: 'open' } }),
      tx.paymentIntent.count({ where: { ...where, OR: [{ status: { notIn: ['succeeded', 'failed', 'cancelled', 'expired'] } }, { refundStatus: { in: ['pending', 'failed'] } }] } }),
      tx.zatcaDocument.count({ where: { ...where, status: { notIn: ['reported', 'cleared'] } } }),
      tx.riderCashCollection.count({ where: { ...where, settlementId: null } }),
    ])
    if (blockers.some(Boolean)) throw new AppError('Close active orders and tills, resolve payments and fiscal submissions, and settle rider cash before branch cutover.', 409, 'BRANCH_CUTOVER_NOT_READY')
    // Every PC ever enrolled keeps its series, so a replacement PC never
    // reuses the numbers its predecessor issued.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-series:${req.user.organizationId}`}))`
    const used = new Set((await tx.branchSyncNode.findMany({ where: { organizationId: req.user.organizationId }, select: { numberSeries: true } })).map(n => n.numberSeries))
    let series = 1
    while (used.has(`P${series}`)) series++
    return tx.branchSyncNode.create({ data: { branchId: body.branchId, name: body.name, syncHr: body.includeHr, organizationId: req.user.organizationId, tokenHash: branchTokenHash(token), provisionedBy: req.user.id, numberSeries: `P${series}` } })
  })
  res.setHeader('Cache-Control', 'no-store')
  res.status(201).json({ id: node.id, branchId: node.branchId, token, numberSeries: node.numberSeries })
})
router.get('/nodes', async (req, res) => {
  const scope = await getBranchScope(req)
  const rows = await prisma.branchSyncNode.findMany({ where: { organizationId: req.user.organizationId, ...(scope.restricted ? { branchId: { in: scope.branchIds } } : {}) }, orderBy: { createdAt: 'asc' },
    select: { id: true, branchId: true, name: true, numberSeries: true, isActive: true, ownsWrites: true, lastSeenAt: true, lastSequence: true, replicaAt: true, replicaError: true, handoverRequestedAt: true, releasedAt: true, releaseReason: true, healthReport: true, healthReportedAt: true, walletRestoreDetectedAt: true } })
  const stale = await prisma.branchWalletReservation.groupBy({ by: ['nodeId'], where: { nodeId: { in: rows.map(r => r.id) }, state: 'reserved', createdAt: { lt: new Date(Date.now() - 15 * 60000) } }, _count: { _all: true } })
  const staleHolds = new Map(stale.map(s => [s.nodeId, s._count._all]))
  res.json({ data: rows.map(({ healthReport: _report, healthReportedAt: _reportedAt, ...r }) => ({ ...r, lastSequence: r.lastSequence.toString(), alerts: r.ownsWrites ? cloudBranchAlerts({ ...r, healthReport: _report, healthReportedAt: _reportedAt, staleWalletHolds: staleHolds.get(r.id) ?? 0 }) : [] })) })
})
router.delete('/nodes/:id', async (req, res) => {
  const node = await prisma.branchSyncNode.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!node) throw new AppError('Branch PC not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, node.branchId)
  // Same lock as an ERP checkpoint commit: revocation waits for an in-flight
  // commit instead of racing it, and every later commit sees the revocation.
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${node.branchId}`}))`
    await tx.branchSyncNode.update({ where: { id: node.id }, data: { isActive: false } })
  }, { timeout: 240000 })
  res.json({ revoked: true })
})
// Planned handover: the PC drains (open orders, tills, rider cash, queued
// online orders), freezes, sends a final checkpoint and then releases.
router.post('/nodes/:id/handover', requirePermission('can_manage_users'), async (req, res) => {
  const node = await prisma.branchSyncNode.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId, isActive: true, ownsWrites: true } })
  if (!node) throw new AppError('Active branch PC not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, node.branchId)
  await prisma.branchSyncNode.update({ where: { id: node.id }, data: { handoverRequestedAt: node.handoverRequestedAt ?? new Date() } })
  res.status(202).json({ handoverRequested: true, message: 'The PC will hand over once its open orders, tills and rider cash are settled and its final records are confirmed.' })
})
// Disaster release for a lost PC. Only after revocation, and only with an
// explicit acknowledgment that records after its last checkpoint are lost.
router.post('/nodes/:id/release', requirePermission('can_manage_users'), requirePermission('can_view_financial_reports'), async (req, res) => {
  const body = z.object({ acknowledgeUnsyncedDataLoss: z.literal(true), reason: z.string().trim().min(10).max(500) }).strict().parse(req.body)
  const node = await prisma.branchSyncNode.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId, ownsWrites: true } })
  if (!node) throw new AppError('Branch PC that owns the branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, node.branchId)
  if (node.isActive) throw new AppError('Revoke the PC first, or use a planned handover while it is reachable.', 409, 'RELEASE_REQUIRES_REVOCATION')
  const released = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${node.branchId}`}))`
    await tx.paymentIntent.updateMany({ where: { branchId: node.branchId, organizationId: node.organizationId, status: 'awaiting_branch' }, data: { status: 'needs_review', failureReason: 'The branch PC was lost before confirming payment posting. Reconcile its latest backup and refund if necessary.' } })
    return tx.branchSyncNode.update({ where: { id: node.id }, data: { ownsWrites: false, releasedAt: new Date(), releasedBy: req.user.id, releaseReason: body.reason } })
  })
  res.json({ released: true, lastCheckpointAt: released.replicaAt, warning: 'Transactions the PC recorded after its last acknowledged checkpoint are not in the cloud.' })
})
// Shared-wallet recovery. Withheld customer money is never released by a
// timer or a revocation: an operator decides each hold with a recorded reason.
const walletAdmin = [requirePermission('can_manage_users'), requirePermission('can_view_financial_reports')]
async function walletNodeFor(req: Request) {
  const node = await prisma.branchSyncNode.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!node) throw new AppError('Branch PC not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, node.branchId)
  return node
}
const maskCode = (code: unknown) => typeof code === 'string' && code.length > 4 ? `…${code.slice(-4)}` : null
router.get('/nodes/:id/wallet-holds', ...walletAdmin, async (req, res) => {
  const node = await walletNodeFor(req)
  const [open, recent] = await Promise.all([
    prisma.branchWalletReservation.findMany({ where: { nodeId: node.id, state: 'reserved' }, orderBy: { createdAt: 'asc' } }),
    prisma.branchWalletReservation.findMany({ where: { nodeId: node.id, state: { not: 'reserved' } }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ])
  res.setHeader('Cache-Control', 'no-store')
  res.json({ restoreDetected: !!node.walletRestoreDetectedAt, restoreDetectedAt: node.walletRestoreDetectedAt, sequenceSeen: node.walletSequenceSeen.toString(), sequenceReported: node.walletSequenceReported?.toString() ?? null,
    holds: [...open, ...recent].map(h => { const p = h.payload as { kind?: string; lines?: { method: string; amount: number; giftCardCode?: string | null }[] }
      return { id: h.id, orderId: h.orderId, reference: h.reference, state: h.state, kind: p.kind, lines: (p.lines ?? []).map(l => ({ method: l.method, amount: l.amount, giftCard: maskCode(l.giftCardCode) })), createdAt: h.createdAt, resolvedBy: h.resolvedBy, resolutionReason: h.resolutionReason, resolvedAt: h.resolvedAt } }) })
})
router.post('/nodes/:id/wallet-holds/:holdId/resolve', ...walletAdmin, async (req, res) => {
  const body = z.object({ action: z.enum(['release', 'commit']), reason: z.string().trim().min(20).max(500), evidenceConfirmed: z.literal(true) }).strict().parse(req.body)
  const node = await walletNodeFor(req)
  // A working PC resolves its own holds from its receipts; operators step in
  // only when it cannot (revoked, released, or restored from a backup).
  if (node.isActive && node.ownsWrites && !node.walletRestoreDetectedAt) throw new AppError('This PC is active and resolves its own wallet holds.', 409, 'WALLET_PC_ACTIVE')
  const state = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-reserve:${req.params.holdId}`}))`
    const hold = await tx.branchWalletReservation.findFirst({ where: { id: req.params.holdId, nodeId: node.id } })
    if (!hold) throw new AppError('Wallet hold not found', 404, 'NOT_FOUND')
    if (hold.state !== 'reserved') throw new AppError('This hold has already been resolved', 409, 'WALLET_RESOLVED')
    await applyHoldResolution(tx, req, hold, body.action)
    const next = body.action === 'release' ? 'released' : 'committed'
    await tx.branchWalletReservation.update({ where: { id: hold.id }, data: { state: next, resolvedBy: req.user.id, resolutionReason: body.reason, resolvedAt: new Date() } })
    return next
  }, { timeout: 20000 })
  res.json({ id: req.params.holdId, state })
})
router.post('/nodes/:id/wallet-recovery/accept', ...walletAdmin, async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(20).max(500) }).strict().parse(req.body)
  const node = await walletNodeFor(req)
  if (!node.walletRestoreDetectedAt) throw new AppError('No restored wallet position is waiting for review', 409, 'WALLET_NO_RESTORE')
  if (await prisma.branchWalletReservation.count({ where: { nodeId: node.id, state: 'reserved' } })) throw new AppError('Resolve every open wallet hold of this PC first', 409, 'WALLET_HOLDS_UNRESOLVED')
  await prisma.branchSyncNode.update({ where: { id: node.id }, data: { walletSequenceSeen: node.walletSequenceReported ?? node.walletSequenceSeen, walletRestoreDetectedAt: null, walletRecoveryAcceptedAt: new Date(), walletRecoveryAcceptedBy: req.user.id, walletRecoveryReason: body.reason } })
  res.json({ accepted: true })
})
router.get('/overview/:nodeId', requirePermission('can_view_financial_reports'), async (req, res) => {
  const node = await prisma.branchSyncNode.findFirst({ where: { id: req.params.nodeId, organizationId: req.user.organizationId } })
  if (!node) throw new AppError('Branch PC not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, node.branchId)
  const rows = await prisma.branchSyncProjection.findMany({ where: { nodeId: node.id, entity: 'DailySale', deleted: false } })
  const netSales = rows.reduce((sum, row) => {
    const sale = row.payload as Record<string, unknown>
    return sale.status === 'void' ? sum : sum + Number(sale.netAmount || 0)
  }, 0)
  res.json({ branchId: node.branchId, dataReceivedThrough: node.lastSeenAt, saleRecords: rows.length, netSales: regionalRoundMoney(netSales), source: 'branch-read-model' })
})
export default router
