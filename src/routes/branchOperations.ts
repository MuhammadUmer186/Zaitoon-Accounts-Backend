import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { prisma } from '../config'
import { exportBranch } from '../services/branchProvisioning'
import { readFile, statfs } from 'fs/promises'
import path from 'path'
import { getBranchScope } from '../utils/branchScope'
import { AppError } from '../middleware/error'
import { z } from 'zod'
import { assertTransferPublicKey } from '../utils/fiscalTransfer'
import { cloudBranchAlerts, currentBranchAlerts } from '../services/branchHealth'

const router = Router()
const REPLICA_FRESH_MS = 15 * 60000
router.use(authenticate)
router.get('/status', async (req, res) => {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') {
    const scope = await getBranchScope(req)
    const nodes = await prisma.branchSyncNode.findMany({ where: { organizationId: req.user.organizationId, ...(scope.restricted ? { branchId: { in: scope.branchIds } } : {}), OR: [{ ownsWrites: true }, { isActive: true }, { lastSequence: { gt: 0 } }] }, select: { branchId: true, isActive: true, ownsWrites: true, replicaRevision: true, replicaAt: true, reportedDataRevision: true, lastSeenAt: true, replicaError: true, replicaErrorAt: true, healthReport: true, healthReportedAt: true } })
    // Central reports are current for a branch only when a full ERP checkpoint
    // was acknowledged recently and covers the revision the PC last reported.
    // A summary heartbeat alone never counts.
    const branches = nodes.map(n => ({ branchId: n.branchId, replicaAt: n.replicaAt, lastSeenAt: n.lastSeenAt, replicaError: n.replicaError, replicaErrorAt: n.replicaErrorAt, alerts: cloudBranchAlerts(n),
      current: n.isActive && !n.replicaError && !!n.replicaAt && Date.now() - n.replicaAt.getTime() < REPLICA_FRESH_MS && n.replicaRevision >= n.reportedDataRevision }))
    res.json({ mode: 'cloud', cloudReportsIncomplete: branches.some(b => !b.current), branches }); return
  }
  let backup: { lastSuccessAt?: string; lastAttemptAt?: string; healthy?: boolean; offsiteHealthy?: boolean | null } | null = null
  try {
    const status = JSON.parse(await readFile(path.join(process.env.BRANCH_STATUS_DIR || 'branch-status', 'backup.json'), 'utf8'))
    backup = { lastSuccessAt: status.lastSuccessAt, lastAttemptAt: status.lastAttemptAt, healthy: status.healthy === true, offsiteHealthy: typeof status.offsiteHealthy === 'boolean' ? status.offsiteHealthy : null }
  } catch { /* Unknown is displayed as unknown, never as a successful backup. */ }
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  const pending = runtime ? await prisma.branchOutbox.count({ where: { nodeId: runtime.nodeId, acknowledgedAt: null } }) : 0
  let storageHealthy: boolean | null = null
  try { const disk = await statfs(process.env.BRANCH_STATUS_DIR || 'branch-status'); storageHealthy = disk.bavail * disk.bsize >= 10 * 1024 ** 3 } catch { /* Unknown storage state remains unknown. */ }
  res.json({ mode: 'branch', local: 'available', backup,
    cloudSync: !runtime || !process.env.BRANCH_CLOUD_URL || !process.env.BRANCH_SYNC_TOKEN ? 'not-configured' : runtime.lastError ? 'retrying' : runtime.lastSyncedAt ? 'connected' : 'waiting',
    pending, storageHealthy,
    erpCheckpoint: !runtime ? null : { state: runtime.replicaChainError ? 'chain-broken' : runtime.replicaError ? 'refused' : runtime.lastReplicaRevision < 0 ? 'never' : runtime.dataRevision > runtime.lastReplicaRevision ? 'behind' : 'current', lastAcknowledgedAt: runtime.lastReplicaAt, error: runtime.replicaChainError ?? runtime.replicaError },
    alerts: await currentBranchAlerts(),
    handover: runtime?.writesFrozen || runtime?.handoverState ? { state: runtime.writesFrozen ?? 'requested', message: runtime.handoverState } : null,
    configurationHealthy: runtime ? !runtime.configurationError && !!runtime.configurationSyncedAt : false, configurationSyncedAt: runtime?.configurationSyncedAt ?? null, lastSyncedAt: runtime?.lastSyncedAt ?? null, timestamp: new Date().toISOString() })
})
router.get('/provision/:branchId', requirePermission('can_manage_settings'), requirePermission('can_manage_users'), requirePermission('can_view_financial_reports'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  const ownerNodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId : undefined
  if (ownerNodeId && !await prisma.branchSyncNode.count({ where: { id: ownerNodeId, organizationId: req.user.organizationId, branchId: req.params.branchId, isActive: true, ownsWrites: true } })) throw new AppError('Branch ownership must be enrolled before provisioning', 409, 'BRANCH_OWNER_REQUIRED')
  const result = await exportBranch(req, req.params.branchId, req.query.includeHr === 'true')
  res.json({ ...result, ownerNodeId })
})
// Installer path: also moves the branch's registered ZATCA devices to the
// enrolled PC, their secrets wrapped for the PC's one-time transfer key.
router.post('/provision/:branchId', requirePermission('can_manage_settings'), requirePermission('can_manage_users'), requirePermission('can_view_financial_reports'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  const body = z.object({ nodeId: z.string().min(1), includeHr: z.boolean().default(false), transferPublicKey: z.string().min(100).max(5000) }).strict().parse(req.body)
  if (!await prisma.branchSyncNode.count({ where: { id: body.nodeId, organizationId: req.user.organizationId, branchId: req.params.branchId, isActive: true, ownsWrites: true } })) throw new AppError('Branch ownership must be enrolled before provisioning', 409, 'BRANCH_OWNER_REQUIRED')
  try { assertTransferPublicKey(body.transferPublicKey) } catch { throw new AppError('Invalid installation transfer key', 400, 'TRANSFER_KEY_INVALID') }
  const result = await exportBranch(req, req.params.branchId, body.includeHr, false, { fiscalTransferKey: body.transferPublicKey })
  res.json({ ...result, ownerNodeId: body.nodeId })
})
router.get('/ready', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`
  res.json({ status: 'ready' })
})
export default router
