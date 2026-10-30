import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { createHash } from 'crypto'
import { notifyBranchAlerts } from './branchHealth'
import { hydrateMedia, pushReplicaMedia } from './branchMedia'
import { branchSchemaFingerprint } from './branchProvisioning'
import { buildBranchReplica, buildBranchDelta, applyBranchDelta, reconcileBranchReplica, replicaDigest, replicaEntities, DeletedRow } from './branchReplica'

const revision = z.string().regex(/^\d{1,18}$/)
const digestValue = z.string().regex(/^[a-f0-9]{64}$/)
const entry = z.object({ entity: z.string().min(1).max(100), part: z.number().int().min(0).max(10000), rows: z.number().int().min(0).max(200), digest: digestValue }).strict()
// baseRevision/baseDigest name the last checkpoint the cloud acknowledged to
// this PC. A checkpoint is accepted only on top of the cloud's current head.
// kind "full" lists every replicated table; "delta" lists only changed tables
// plus DELETED parts of { entity, id } tombstones.
const DELETED = '__deleted'
const manifestSchema = z.object({ kind: z.enum(['full', 'delta']), schema: digestValue, revision, baseRevision: z.string().regex(/^(-1|\d{1,18})$/), baseDigest: digestValue.nullable(), parts: z.array(entry).max(10000) }).strict()
const partSchema = z.object({ entity: z.string().min(1).max(100), part: z.number().int().min(0).max(10000), rows: z.array(z.record(z.string(), z.unknown())).max(200) }).strict()
const SESSION_TTL_MS = 3600000
const chainBroken = () => new AppError('The cloud holds newer branch history than this PC. Synchronization is stopped until a reviewed recovery.', 409, 'REPLICA_CHAIN_BROKEN')

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
async function authorized(tx: Prisma.TransactionClient, token: string) {
  const node = await tx.branchSyncNode.findFirst({ where: { tokenHash: tokenHash(token), isActive: true, ownsWrites: true } })
  if (!node || !await tx.organization.count({ where: { id: node.organizationId, isActive: true } }) || !await tx.branch.count({ where: { id: node.branchId, organizationId: node.organizationId, isActive: true } })) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  return node
}
// Re-read once the advisory locks are held. Revocation takes the same
// branch-owner lock, so one committed while this request waited is observed
// here and one issued later waits for this transaction. No row lock is held:
// command claims and event uploads keep updating the node's heartbeat.
async function lockedNode(tx: Prisma.TransactionClient, token: string, id: string) {
  const node = await authorized(tx, token)
  if (node.id !== id) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  return node
}

export async function replicaHead(token: string) {
  const node = await prisma.$transaction(tx => authorized(tx, token))
  return { revision: node.replicaRevision.toString(), digest: node.replicaDigest }
}

export async function beginReplica(token: string, input: unknown) {
  const data = manifestSchema.parse(input)
  if (data.schema !== branchSchemaFingerprint) throw new AppError('ERP schema versions differ', 409, 'REPLICA_SCHEMA_MISMATCH')
  const allowed = new Set<string>([...replicaEntities, 'Customer', ...(data.kind === 'delta' ? [DELETED] : [])]), parts = new Set<string>()
  let rows = 0
  for (const part of data.parts) {
    if (!allowed.has(part.entity) || parts.has(`${part.entity}:${part.part}`) || (rows += part.rows) > 250000) throw new AppError('Invalid ERP manifest', 400, 'REPLICA_INVALID')
    parts.add(`${part.entity}:${part.part}`)
  }
  for (const entity of allowed) {
    const indexes = data.parts.filter(p => p.entity === entity).map(p => p.part).sort((a, b) => a - b)
    // A full checkpoint must list every table; a delta only the changed ones.
    if (!indexes.length && data.kind === 'full' || indexes.some((part, i) => part !== i)) throw new AppError('Manifest is incomplete', 400, 'REPLICA_INVALID')
  }
  const digest = replicaDigest(data), value = BigInt(data.revision), base = BigInt(data.baseRevision)
  if (value <= base) throw new AppError('ERP checkpoint must advance', 400, 'REPLICA_INVALID')
  return prisma.$transaction(async tx => {
    const found = await authorized(tx, token)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${found.branchId}`}))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-replica:${found.id}`}))`
    const node = await lockedNode(tx, token, found.id)
    const existing = await tx.branchReplicaSession.findUnique({ where: { nodeId_revision: { nodeId: node.id, revision: value } } })
    // A committed checkpoint is an immutable receipt for an exact retry.
    if (existing?.committedAt) {
      if (existing.digest !== digest) throw new AppError('ERP revision content changed', 409, 'REPLICA_REPLAY_CONFLICT')
      return { id: existing.id, committed: true, digest }
    }
    if (base !== node.replicaRevision || data.baseDigest !== node.replicaDigest) throw chainBroken()
    if (existing && existing.digest === digest) {
      await tx.branchReplicaSession.update({ where: { id: existing.id }, data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
      return { id: existing.id, committed: false, digest }
    }
    // Uncommitted uploads from the same base are superseded, including a
    // different upload that reused this revision number after a PC restore.
    const superseded = await tx.branchReplicaSession.findMany({ where: { nodeId: node.id, committedAt: null, OR: [{ revision: { lte: value } }, { expiresAt: { lt: new Date() } }] }, select: { id: true } })
    if (superseded.length) {
      await tx.branchReplicaPart.deleteMany({ where: { sessionId: { in: superseded.map(s => s.id) } } })
      await tx.branchReplicaSession.deleteMany({ where: { id: { in: superseded.map(s => s.id) } } })
    }
    if (await tx.branchReplicaSession.count({ where: { nodeId: node.id, committedAt: null } }) >= 2) throw new AppError('Finish or cancel an earlier ERP upload', 409, 'REPLICA_UPLOAD_PENDING')
    const session = await tx.branchReplicaSession.create({ data: { nodeId: node.id, kind: data.kind, revision: value, baseRevision: base, baseDigest: data.baseDigest, schema: data.schema, manifest: data.parts, digest, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } })
    return { id: session.id, committed: false, digest }
  })
}
export async function receiveReplicaPart(token: string, sessionId: string, input: unknown) {
  const data = partSchema.parse(input), digest = replicaDigest(data.rows)
  if (Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024) throw new AppError('ERP part is too large', 413, 'REPLICA_TOO_LARGE')
  return prisma.$transaction(async tx => {
    const node = await authorized(tx, token)
    const session = await tx.branchReplicaSession.findFirst({ where: { id: sessionId, nodeId: node.id, expiresAt: { gt: new Date() } } })
    if (!session || session.committedAt) throw new AppError('ERP upload is unavailable', 409, 'REPLICA_SESSION_INVALID')
    const manifest = session.manifest as unknown as z.infer<typeof entry>[]
    const expected = manifest.find(p => p.entity === data.entity && p.part === data.part)
    if (!expected || expected.rows !== data.rows.length || expected.digest !== digest) throw new AppError('ERP part differs from the manifest', 409, 'REPLICA_REPLAY_CONFLICT')
    const key = { sessionId, entity: data.entity, part: data.part }
    await tx.branchReplicaPart.upsert({ where: { sessionId_entity_part: key }, create: { ...key, rows: data.rows as Prisma.InputJsonArray, digest }, update: {} })
    return { received: true }
  })
}
// A checkpoint that cannot apply stops this branch's central reporting until
// someone acts, so the reason is recorded on the node for the cloud status
// instead of being retried silently.
function describeFailure(error: unknown): AppError | null {
  const known = error as { code?: string; meta?: { modelName?: string; target?: string[] | string } }
  if (known?.code === 'P2002') return new AppError(`The central ERP already has a different ${known.meta?.modelName ?? 'record'} with the same ${[known.meta?.target].flat().filter(Boolean).join(', ') || 'unique value'}. Resolve the duplicate, then the PC retries automatically.`, 409, 'REPLICA_CONFLICT')
  if (error instanceof AppError && /^(REPLICA_|BRANCH_FORBIDDEN)/.test(error.code) && !['REPLICA_SESSION_INVALID', 'REPLICA_INCOMPLETE'].includes(error.code)) return error
  return null
}
export async function commitReplica(token: string, sessionId: string) {
  try {
    return await applyCommit(token, sessionId)
  } catch (error) {
    const failure = describeFailure(error)
    if (failure) await prisma.branchSyncNode.updateMany({ where: { tokenHash: tokenHash(token), isActive: true }, data: { replicaError: `${failure.code}: ${failure.message}`.slice(0, 500), replicaErrorAt: new Date() } }).catch(() => undefined)
    throw failure ?? error
  }
}
async function applyCommit(token: string, sessionId: string) {
  return prisma.$transaction(async tx => {
    const found = await authorized(tx, token)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${found.branchId}`}))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-replica:${found.id}`}))`
    const node = await lockedNode(tx, token, found.id)
    const session = await tx.branchReplicaSession.findFirst({ where: { id: sessionId, nodeId: node.id } })
    if (!session) throw new AppError('ERP upload not found', 404, 'NOT_FOUND')
    if (session.committedAt) return { committed: true, revision: session.revision.toString(), digest: session.digest }
    if (session.expiresAt < new Date()) throw new AppError('ERP session is stale', 409, 'REPLICA_SESSION_INVALID')
    // The head may have moved since begin (for example a second installation
    // using the same credentials). Only the exact acknowledged base may advance.
    if (session.baseRevision === null || session.baseRevision !== node.replicaRevision || session.baseDigest !== node.replicaDigest) throw chainBroken()
    const parts = await tx.branchReplicaPart.findMany({ where: { sessionId }, orderBy: [{ entity: 'asc' }, { part: 'asc' }] })
    const manifest = session.manifest as unknown as z.infer<typeof entry>[]
    if (parts.length !== manifest.length) throw new AppError('ERP upload is incomplete', 409, 'REPLICA_INCOMPLETE')
    const tables: Record<string, Record<string, unknown>[]> = {}
    for (const part of parts) {
      const expected = manifest.find(p => p.entity === part.entity && p.part === part.part)
      if (!expected || expected.digest !== replicaDigest(part.rows)) throw new AppError('ERP staged data failed integrity checks', 409, 'REPLICA_INVALID')
      tables[part.entity] ??= []
      tables[part.entity].push(...part.rows as unknown as Record<string, unknown>[])
    }
    const deleted = (tables[DELETED] ?? []) as unknown as DeletedRow[]
    delete tables[DELETED]
    if (!node.syncHr && (Object.entries(tables).some(([name, rows]) => name.startsWith('Hr') && rows.length) || deleted.some(d => d?.entity?.startsWith('Hr')))) throw new AppError('This PC is not enrolled for confidential HR synchronization', 403, 'BRANCH_FORBIDDEN')
    await hydrateMedia(tables, node)
    if (session.kind === 'delta') await applyBranchDelta(tx, node, tables, deleted)
    else await reconcileBranchReplica(tx, node, tables)
    await tx.branchSyncNode.update({ where: { id: node.id }, data: { replicaRevision: session.revision, replicaDigest: session.digest, replicaAt: new Date(), lastSeenAt: new Date(), replicaError: null, replicaErrorAt: null } })
    // The session digest remains as the replay receipt; staged business payloads
    // and the manifest are removed once the live ERP transaction commits.
    await tx.branchReplicaSession.update({ where: { id: sessionId }, data: { committedAt: new Date(), manifest: [] } })
    await tx.branchReplicaPart.deleteMany({ where: { sessionId } })
    return { committed: true, revision: session.revision.toString(), digest: session.digest }
  }, { timeout: 180000 })
}

export async function cancelReplica(token: string, sessionId: string) {
  return prisma.$transaction(async tx => {
    const node = await authorized(tx, token)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-replica:${node.id}`}))`
    const session = await tx.branchReplicaSession.findFirst({ where: { id: sessionId, nodeId: node.id } })
    if (!session || session.committedAt) throw new AppError('Only an uncommitted ERP upload can be cancelled', 409, 'REPLICA_SESSION_INVALID')
    await tx.branchReplicaPart.deleteMany({ where: { sessionId } })
    await tx.branchReplicaSession.delete({ where: { id: sessionId } })
    return { cancelled: true }
  })
}

// Cloud housekeeping: bounded staging and command history. Committed receipts
// needed for the chain (each node's head) are always kept.
export async function purgeBranchControlPlane(now = new Date()) {
  const day = 24 * 3600000
  const stale = await prisma.branchReplicaSession.findMany({ where: { committedAt: null, expiresAt: { lt: now } }, select: { id: true } })
  if (stale.length) {
    await prisma.branchReplicaPart.deleteMany({ where: { sessionId: { in: stale.map(s => s.id) } } })
    await prisma.branchReplicaSession.deleteMany({ where: { id: { in: stale.map(s => s.id) }, committedAt: null } })
  }
  const heads = await prisma.branchSyncNode.findMany({ select: { id: true, replicaRevision: true } })
  let receipts = 0
  for (const head of heads) receipts += (await prisma.branchReplicaSession.deleteMany({ where: { nodeId: head.id, committedAt: { lt: new Date(now.getTime() - 7 * day) }, revision: { lt: head.replicaRevision } } })).count
  const statuses = await prisma.branchRemoteCommand.deleteMany({ where: { kind: 'online-status', createdAt: { lt: new Date(now.getTime() - day) }, status: { not: 'claimed' } } })
  // Placement receipts keep tracking links and duplicate-submit protection alive.
  const placements = await prisma.branchRemoteCommand.deleteMany({ where: { kind: 'online-place', createdAt: { lt: new Date(now.getTime() - 90 * day) }, status: { in: ['completed', 'expired'] } } })
  return { staleSessions: stale.length, receipts, statusCommands: statuses.count, placementCommands: placements.count }
}
export function startBranchControlPlaneMaintenance() {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return
  const run = () => { void purgeBranchControlPlane().catch(() => undefined); setTimeout(run, 15 * 60000).unref() }
  setTimeout(run, 60000).unref()
  const alerts = () => { void notifyBranchAlerts().catch(() => undefined); setTimeout(alerts, Number(process.env.ALERT_INTERVAL_MS) || 5 * 60000).unref() }
  setTimeout(alerts, 30000).unref()
}

class ReplicaHttpError extends Error { constructor(public status: number, public code?: string) { super(`ERP upload was not acknowledged (${status}${code ? ` ${code}` : ''})`) } }
let publishing = false
export async function publishBranchReplica() {
  if (publishing || process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  if (!endpoint || !token) return
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('ERP sync requires HTTPS')
  publishing = true
  try {
    let runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
    // A broken chain needs an operator; retrying would only repeat the refusal.
    if (!runtime || runtime.replicaChainError) return false
    async function call(route: string, body?: unknown) {
      const response = await fetch(`${endpoint!.replace(/\/$/, '')}/api/v1/branch-sync/replica${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(180000) })
      if (!response.ok) throw new ReplicaHttpError(response.status, await response.json().then((b: unknown) => { const code = (b as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : undefined }, () => undefined))
      return response.json() as Promise<{ id?: string; committed?: boolean; revision?: string; digest?: string | null }>
    }
    const head = await call('/head')
    const acked = { revision: runtime.lastReplicaRevision.toString(), digest: runtime.lastReplicaDigest }
    const pending = runtime.pendingReplicaRevision !== null ? { revision: runtime.pendingReplicaRevision.toString(), digest: runtime.pendingReplicaDigest } : null
    if (pending && head.revision === pending.revision && head.digest === pending.digest) {
      // The previous upload committed but its acknowledgment was lost.
      runtime = await prisma.branchRuntime.update({ where: { id: 'local' }, data: { lastReplicaRevision: BigInt(pending.revision), lastReplicaDigest: pending.digest, lastReplicaAt: new Date(), pendingReplicaRevision: null, pendingReplicaDigest: null } })
    } else if (head.revision !== acked.revision || (head.digest ?? null) !== acked.digest) {
      await prisma.branchRuntime.update({ where: { id: 'local' }, data: { replicaChainError: 'Cloud history is newer than this PC (possible restore from an older backup or a second installation). Reviewed recovery required.' } })
      return false
    }
    if (runtime.dataRevision === runtime.lastReplicaRevision) return true
    // Incremental by default: cost follows what changed, not the branch's
    // history. A full checkpoint is used only when the change log cannot prove
    // it covers every revision since the last acknowledged checkpoint.
    const delta = await buildBranchDelta(prisma, runtime.lastReplicaRevision)
    const snapshot = delta
      ? { kind: 'delta' as const, schema: delta.schema, revision: delta.revision, tables: { ...delta.tables, ...(delta.deleted.length && { [DELETED]: delta.deleted as unknown as Record<string, unknown>[] }) } }
      : { kind: 'full' as const, ...await buildBranchReplica(prisma) }
    await pushReplicaMedia(snapshot.tables, runtime, endpoint, token)
    const parts = Object.entries(snapshot.tables).flatMap(([entity, rows]) => {
      const result: { entity: string; part: number; rows: Record<string, unknown>[] }[] = []
      // A full checkpoint sends an empty part for an empty table so the cloud
      // can see that it is empty; a delta simply omits unchanged tables.
      for (let i = 0; i < (snapshot.kind === 'full' ? Math.max(rows.length, 1) : rows.length); i += 200) result.push({ entity, part: result.length, rows: rows.slice(i, i + 200) })
      return result
    })
    const manifest = { kind: snapshot.kind, schema: snapshot.schema, revision: snapshot.revision, baseRevision: runtime.lastReplicaRevision.toString(), baseDigest: runtime.lastReplicaDigest, parts: parts.map(p => ({ entity: p.entity, part: p.part, rows: p.rows.length, digest: replicaDigest(p.rows) })) }
    const digest = replicaDigest(manifest)
    await prisma.branchRuntime.update({ where: { id: 'local' }, data: { pendingReplicaRevision: BigInt(snapshot.revision), pendingReplicaDigest: digest } })
    const session = await call('/begin', manifest)
    if (!session.id || session.digest !== digest) throw new Error('Invalid ERP session acknowledgment')
    if (!session.committed) {
      for (const part of parts) await call(`/${session.id}/part`, part)
      const committed = await call(`/${session.id}/commit`, {})
      if (!committed.committed || committed.revision !== snapshot.revision || committed.digest !== digest) throw new Error('Invalid ERP commit acknowledgment')
    }
    await prisma.$transaction([
      prisma.branchRuntime.update({ where: { id: 'local' }, data: { lastReplicaRevision: BigInt(snapshot.revision), lastReplicaDigest: digest, lastReplicaAt: new Date(), pendingReplicaRevision: null, pendingReplicaDigest: null, replicaError: null } }),
      // Acknowledged changes are in the cloud; the log only needs to prove
      // coverage after the new base.
      prisma.branchChangeLog.deleteMany({ where: { revision: { lte: BigInt(snapshot.revision) } } }),
    ])
    return true
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('MEDIA_')) await prisma.branchRuntime.update({ where: { id: 'local' }, data: { replicaError: `${error.code}: ${error.message}` } }).catch(() => undefined)
    if (error instanceof ReplicaHttpError && error.code === 'REPLICA_CHAIN_BROKEN') await prisma.branchRuntime.update({ where: { id: 'local' }, data: { replicaChainError: 'Cloud refused this PC\'s checkpoint chain. Reviewed recovery required.' } }).catch(() => undefined)
    // A refusal (not an outage) is recorded so the PC status names it.
    else if (error instanceof ReplicaHttpError && error.status >= 400 && error.status < 500) await prisma.branchRuntime.update({ where: { id: 'local' }, data: { replicaError: `Cloud refused the ERP checkpoint (${error.code ?? `HTTP ${error.status}`}). See the branch status in the cloud.` } }).catch(() => undefined)
    return false
  } finally { publishing = false }
}
