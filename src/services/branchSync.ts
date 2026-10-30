import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { applyBranchConfiguration } from './branchConfiguration'
import { pullPackageMedia } from './branchMedia'
import { publishBranchReplica } from './branchReplicaTransport'
import { processBranchOnlineCommands } from './branchOnline'
import { reportBranchHealth } from './branchHealth'

export const syncEntities = ['DailySale', 'CustomerOrder', 'Expense', 'CashClosing', 'StockMovement'] as const
const eventSchema = z.object({ sequence: z.string().regex(/^[1-9]\d{0,18}$/).refine(v => BigInt(v) <= 9223372036854775807n), entity: z.enum(syncEntities), entityId: z.string().min(1).max(200), operation: z.enum(['INSERT', 'UPDATE', 'DELETE']), payload: z.record(z.string(), z.unknown()) }).strict()
export const syncBatchSchema = z.object({ version: z.literal(1), nodeId: z.string().uuid(), dataRevision: z.string().regex(/^\d{1,18}$/).optional(), events: z.array(eventSchema).max(100) }).strict()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export const branchTokenHash = hash

// The inbox is a separate cloud read model. Importing directly into live ERP
// tables would double-post stock/ledger effects and create competing writers.
export async function receiveBranchEvents(token: string, input: unknown) {
  const batch = syncBatchSchema.parse(input)
  return prisma.$transaction(async tx => {
    const found = await tx.branchSyncNode.findFirst({ where: { id: batch.nodeId, tokenHash: hash(token), isActive: true, ownsWrites: true } })
    if (!found) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${found.branchId}`}))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-inbox:${batch.nodeId}`}))`
    const node = await tx.branchSyncNode.findFirst({ where: { id: batch.nodeId, tokenHash: hash(token), isActive: true, ownsWrites: true } })
    if (!node || !await tx.organization.count({ where: { id: node.organizationId, isActive: true } }) || !await tx.branch.count({ where: { id: node.branchId, organizationId: node.organizationId, isActive: true } })) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
    let latest = node.lastSequence
    for (const event of batch.events) {
      const seq = BigInt(event.sequence), digest = hash(canonical(event))
      if (event.payload.organizationId !== node.organizationId || event.payload.branchId !== node.branchId || event.payload.id !== event.entityId) throw new AppError('Branch event identity mismatch', 403, 'BRANCH_FORBIDDEN')
      const old = await tx.branchSyncEvent.findUnique({ where: { nodeId_sequence: { nodeId: node.id, sequence: seq } } })
      if (old) { if (old.digest !== digest) throw new AppError('An acknowledged event cannot be changed', 409, 'SYNC_REPLAY_CONFLICT'); continue }
      if (seq !== latest + 1n) throw new AppError('Events arrived out of order or with a sequence gap; manual recovery required', 409, 'SYNC_ORDER_CONFLICT')
      await tx.branchSyncEvent.create({ data: { nodeId: node.id, sequence: seq, digest } })
      const key = { nodeId: node.id, entity: event.entity, entityId: event.entityId }
      const data = { sequence: seq, payload: event.payload as Prisma.InputJsonObject, deleted: event.operation === 'DELETE', receivedAt: new Date() }
      await tx.branchSyncProjection.upsert({ where: { nodeId_entity_entityId: key }, create: { ...key, ...data }, update: data })
      latest = seq
    }
    const reported = batch.dataRevision ? BigInt(batch.dataRevision) : node.reportedDataRevision
    await tx.branchSyncNode.update({ where: { id: node.id }, data: { lastSequence: latest, lastSeenAt: new Date(), reportedDataRevision: reported > node.reportedDataRevision ? reported : node.reportedDataRevision } })
    return { nodeId: node.id, acknowledged: batch.events.map(e => e.sequence) }
  }, { timeout: 30000 })
}

let running = false
let lastConfigurationAttempt = 0
export async function flushBranchOutbox() {
  if (running || process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  if (!endpoint || !token) return
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('Branch synchronization requires HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid branch cloud URL')
  running = true
  try {
    const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
    if (!runtime) return
    if (Date.now() - Math.max(lastConfigurationAttempt, runtime.configurationSyncedAt?.getTime() ?? 0) >= 60000) {
      lastConfigurationAttempt = Date.now()
      try {
        const configuration = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/configuration`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000), redirect: 'error' })
        if (!configuration.ok) throw new Error('Cloud configuration unavailable')
        const packet = await configuration.json() as { tables: Record<string, Record<string, unknown>[]> }
        await pullPackageMedia(packet.tables, runtime, endpoint, token)
        await applyBranchConfiguration(prisma, packet)
        await prisma.branchRuntime.update({ where: { id: 'local' }, data: { configurationError: null } })
      } catch {
        await prisma.branchRuntime.update({ where: { id: 'local' }, data: { configurationError: 'Configuration update failed; last working settings retained' } })
      }
    }
    const pending = await prisma.branchOutbox.findMany({ where: { nodeId: runtime.nodeId, acknowledgedAt: null }, orderBy: { sequence: 'asc' }, take: 100 })
    const events = pending.map(e => ({ sequence: e.sequence.toString(), entity: e.entity, entityId: e.entityId, operation: e.operation, payload: e.payload }))
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ version: 1, nodeId: runtime.nodeId, dataRevision: runtime.dataRevision.toString(), events }), signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw new Error(`Cloud returned HTTP ${response.status}`)
    const ack = await response.json() as { nodeId?: string; acknowledged?: string[] }
    if (ack.nodeId !== runtime.nodeId || !Array.isArray(ack.acknowledged) || canonical(ack.acknowledged) !== canonical(events.map(e => e.sequence))) throw new Error('Cloud acknowledgment did not match the batch')
    await prisma.$transaction(async tx => {
      await tx.branchOutbox.updateMany({ where: { id: { in: pending.map(e => e.id) }, nodeId: runtime.nodeId }, data: { acknowledgedAt: new Date() } })
      await tx.branchRuntime.update({ where: { id: 'local' }, data: { lastSyncedAt: new Date(), lastError: null } })
    })
    return true
  } catch {
    // Remote bodies and URLs may contain secrets. Expose only a fixed message.
    await prisma.branchRuntime.updateMany({ where: { id: 'local' }, data: { lastError: 'Cloud sync failed; pending records retained for retry' } }).catch(() => undefined)
    return false
  } finally { running = false }
}

export function startBranchSyncWorker() {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  let failures = 0
  let lastReplicaAttempt = 0
  const run = async () => {
    try { const result = await flushBranchOutbox(); failures = result === false ? Math.min(failures + 1, 4) : 0 } catch { failures = Math.min(failures + 1, 4) }
    if (Date.now() - lastReplicaAttempt >= (Number(process.env.BRANCH_REPLICA_INTERVAL_MS) || 60000)) { lastReplicaAttempt = Date.now(); void publishBranchReplica().catch(() => undefined) }
    setTimeout(run, Math.min(60000, 5000 * 2 ** failures)).unref()
  }
  void run()
  // Online customers wait on this loop, and each claim is the PC's heartbeat.
  // An outbox conflict must not make the branch look offline to the cloud.
  const commands = async () => {
    await processBranchOnlineCommands().catch(() => undefined)
    setTimeout(commands, Number(process.env.BRANCH_COMMAND_INTERVAL_MS) || 5000).unref()
  }
  void commands()
  const health = async () => {
    await reportBranchHealth().catch(() => undefined)
    setTimeout(health, Number(process.env.BRANCH_HEALTH_INTERVAL_MS) || 300000).unref()
  }
  void health()
}
