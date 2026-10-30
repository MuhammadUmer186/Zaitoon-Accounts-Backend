import { createHash, randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { replicaDigest } from './branchReplica'
import { onlineOrderId, onlineTrackingCode, parseOnlineTrackingCode } from '../utils/onlineOrder'
import { onlineOrderSchema, placeOnlineOrder, trackedOnlineOrder, onlineOrderView } from './onlinePlacement'
import { publicOrder } from '../routes/public'
import { advanceHandover, freezeReleased } from './branchHandover'
import { acknowledgeBranchPayment, applyBranchPayment, flushBranchRefunds } from './branchPayments'
import { paymentStatus } from './payments'
import { flushBranchWallets } from './branchWallets'
import { applyStockTransfer, acknowledgeStockTransfer, transferKinds } from './branchTransfers'

// Cloud-side queue for branches whose transactions are owned by a local PC.
// Request states, in customer terms:
//   queued   - stored in the cloud; the branch PC has not picked it up
//   received - the branch PC claimed it; the outcome is not yet reported
//   placed   - the branch database committed the order (staff still accept it)
//   rejected - the branch answered with a definite refusal
//   expired  - the branch never picked it up in time; nothing was created
//   unknown  - the branch picked it up but never reported back; it may exist
export const ONLINE_HEARTBEAT_MS = 45000
const QUEUE_TTL_MS = 120000, LEASE_MS = 60000, UNKNOWN_AFTER_MS = 24 * 3600000, MAX_ATTEMPTS = 30
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const online = (node: { isActive: boolean; ownsWrites: boolean; lastSeenAt: Date | null } | null) => !!node?.isActive && node.ownsWrites && !!node.lastSeenAt && node.lastSeenAt.getTime() >= Date.now() - ONLINE_HEARTBEAT_MS
type Command = { status: string; responseStatus: number | null; result: Prisma.JsonValue | null }
type Placed = { order?: Record<string, unknown>; message?: string; code?: string }

function requestState(command: Command) {
  if (command.status === 'queued') return { state: 'queued', message: 'Sent. Waiting for the restaurant\'s system to receive your order. It is not yet accepted or paid.' }
  if (command.status === 'claimed') return { state: 'received', message: 'The restaurant\'s system is processing your order. It is not yet accepted or paid.' }
  if (command.status === 'expired') return { state: 'expired', message: 'The restaurant did not receive this order in time. No order was created and you were not charged. Please try again or call the restaurant.' }
  if (command.status === 'unknown') return { state: 'unknown', message: 'We could not confirm whether the restaurant received this order. Please call the restaurant before ordering again.' }
  const result = command.result as Placed | null
  if ((command.responseStatus ?? 500) >= 400 || !result?.order?.id) return { state: 'rejected', message: result?.message || 'The restaurant could not accept this order. Please update your cart and try again.' }
  return { state: 'placed', order: result.order }
}

export async function queueOnlineOrder(organizationId: string, branchId: string, body: { requestId: string; [key: string]: unknown }) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return null
  // A revoked PC still owns the branch's writes until a reviewed handover.
  const node = await prisma.branchSyncNode.findFirst({ where: { organizationId, branchId, ownsWrites: true } })
  if (!node) return null
  const key = `online:${body.requestId}`, digest = replicaDigest(body), publicId = onlineOrderId(branchId, body.requestId)
  const answer = (command: Command) => {
    const { order, ...state } = requestState(command)
    return { trackingCode: onlineTrackingCode(publicId), ...state, ...(order && { order: { ...order, paymentsAvailable: false } }) }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const prior = await prisma.branchRemoteCommand.findUnique({ where: { nodeId_key: { nodeId: node.id, key } } })
    if (prior) {
      if (prior.digest !== digest) throw new AppError('This order request was already used with different details', 409, 'ONLINE_REQUEST_CONFLICT')
      return answer(prior)
    }
    if (!online(node)) throw new AppError('This branch is temporarily offline. Please call the restaurant or try again shortly.', 503, 'BRANCH_OFFLINE')
    if (node.handoverRequestedAt) throw new AppError('This branch is not taking online orders right now. Please call the restaurant.', 503, 'BRANCH_HANDOVER')
    try {
      const saved = await prisma.branchRemoteCommand.create({ data: { nodeId: node.id, organizationId, branchId, key, publicId, kind: 'online-place', digest, payload: body as Prisma.InputJsonObject, expiresAt: new Date(Date.now() + QUEUE_TTL_MS) } })
      return answer(saved)
    } catch (error) {
      // Concurrent duplicate submit: re-read the winner and compare details.
      if ((error as { code?: string }).code !== 'P2002') throw error
    }
  }
  throw new AppError('Please try again', 503, 'ONLINE_REQUEST_BUSY')
}

async function commandNode(token: string) {
  const node = await prisma.branchSyncNode.findFirst({ where: { tokenHash: hash(token), isActive: true, ownsWrites: true } })
  // Distinct from "unauthorized": this PC no longer owns its branch and must
  // stop recording transactions (it freezes itself on this answer).
  if (!node && await prisma.branchSyncNode.count({ where: { tokenHash: hash(token), ownsWrites: false, releasedAt: { not: null } } })) throw new AppError('This PC no longer owns its branch.', 410, 'BRANCH_RELEASED')
  if (!node || !await prisma.branch.count({ where: { id: node.branchId, organizationId: node.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  return node
}
export async function claimOnlineCommands(token: string) {
  const node = await commandNode(token)
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${node.branchId}`}))`
    if (!await tx.branchSyncNode.count({ where: { id: node.id, isActive: true, ownsWrites: true } })) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-commands:${node.id}`}))`
    const now = new Date()
    // Claiming is proof of life: the cloud may accept new requests for this PC.
    await tx.branchSyncNode.update({ where: { id: node.id }, data: { lastSeenAt: now } })
    await tx.branchRemoteCommand.updateMany({ where: { nodeId: node.id, status: 'queued', expiresAt: { lt: now } }, data: { status: 'expired', payload: {} } })
    // A claimed command may already be committed at the branch; never call it
    // failed. After the retry window it is reported as unknown instead.
    await tx.branchRemoteCommand.updateMany({ where: { nodeId: node.id, kind: { notIn: ['payment-settle', ...transferKinds] }, status: 'claimed', leaseUntil: { lt: now }, OR: [{ createdAt: { lt: new Date(now.getTime() - UNKNOWN_AFTER_MS) } }, { attempts: { gte: MAX_ATTEMPTS } }] }, data: { status: 'unknown', leaseUntil: null } })
    const commands = await tx.branchRemoteCommand.findMany({ where: { nodeId: node.id, OR: [{ status: 'queued', expiresAt: { gt: now } }, { status: 'claimed', leaseUntil: { lt: now } }] }, orderBy: { createdAt: 'asc' }, take: 10 })
    const claimed = []
    for (const command of commands) {
      const claimToken = randomBytes(32).toString('hex')
      await tx.branchRemoteCommand.update({ where: { id: command.id }, data: { status: 'claimed', claimToken: hash(claimToken), leaseUntil: new Date(now.getTime() + LEASE_MS), claimedAt: command.claimedAt ?? now, attempts: { increment: 1 } } })
      claimed.push({ id: command.id, claimToken, kind: command.kind, branchId: node.branchId, organizationId: node.organizationId, payload: command.payload })
    }
    return { commands: claimed, handoverRequested: !!node.handoverRequestedAt }
  })
}
export async function completeOnlineCommand(token: string, id: string, input: { claimToken: string; status: number; result: unknown }) {
  const node = await commandNode(token)
  if (!/^[a-f0-9]{64}$/.test(input.claimToken) || !Number.isInteger(input.status) || input.status < 200 || input.status >= 500 || Buffer.byteLength(JSON.stringify(input.result)) > 1024 * 1024) throw new AppError('Invalid branch command acknowledgment', 400, 'COMMAND_INVALID')
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${node.branchId}`}))`
    if (!await tx.branchSyncNode.count({ where: { id: node.id, isActive: true, ownsWrites: true } })) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-commands:${node.id}`}))`
    const command = await tx.branchRemoteCommand.findFirst({ where: { id, nodeId: node.id, claimToken: hash(input.claimToken) } })
    // A late answer to an "unknown" request is still the truth; record it.
    if (!command || !['claimed', 'completed', 'unknown'].includes(command.status)) throw new AppError('Command claim no longer belongs to this PC', 409, 'COMMAND_CLAIM_INVALID')
    if (command.status === 'completed') {
      if (command.responseStatus !== input.status || replicaDigest(command.result) !== replicaDigest(input.result)) throw new AppError('Completed command response cannot be changed', 409, 'COMMAND_REPLAY_CONFLICT')
      return { acknowledged: true }
    }
    await acknowledgeBranchPayment(tx, command, input)
    await acknowledgeStockTransfer(tx, command, input)
    await tx.branchRemoteCommand.update({ where: { id }, data: { status: 'completed', responseStatus: input.status, result: input.result as Prisma.InputJsonValue, completedAt: new Date(), ...(command.kind === 'online-place' && { payload: {} }), leaseUntil: null } })
    return { acknowledged: true }
  })
}

export async function isBranchRelayedOrder(code: string) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return false
  const id = parseOnlineTrackingCode(code)
  return !!id && !!await prisma.branchRemoteCommand.count({ where: { publicId: id, kind: 'online-place' } })
}

export async function remoteOnlineTracking(code: string) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return null
  const id = parseOnlineTrackingCode(code)
  if (!id) return null
  const request = await prisma.branchRemoteCommand.findFirst({ where: { publicId: id, kind: 'online-place' } })
  if (!request) return null
  const node = await prisma.branchSyncNode.findUnique({ where: { id: request.nodeId } })
  const reachable = online(node)
  const placed = requestState(request)
  if (placed.state !== 'placed') return { ...placed, pendingBranchReceipt: ['queued', 'received'].includes(placed.state), failed: ['rejected', 'expired'].includes(placed.state), branchOffline: !reachable }
  // One refresh row per order, re-armed at most every 10 seconds, so public
  // polling cannot grow the queue.
  const statusKey = `online-status:${id}`, now = Date.now()
  if (reachable) {
    const localOrderId = String(placed.order!.id)
    try {
      await prisma.branchRemoteCommand.create({ data: { nodeId: request.nodeId, organizationId: request.organizationId, branchId: request.branchId, key: statusKey, publicId: id, kind: 'online-status', digest: hash(localOrderId), payload: { orderId: localOrderId }, expiresAt: new Date(now + 30000) } })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      await prisma.branchRemoteCommand.updateMany({ where: { nodeId: request.nodeId, key: statusKey, status: { in: ['completed', 'expired', 'unknown'] }, OR: [{ completedAt: null }, { completedAt: { lt: new Date(now - 10000) } }] }, data: { status: 'queued', claimToken: null, leaseUntil: null, attempts: 0, expiresAt: new Date(now + 30000) } })
    }
  }
  const latest = await prisma.branchRemoteCommand.findFirst({ where: { nodeId: request.nodeId, key: statusKey, responseStatus: 200 } })
  const latestOrder = (latest?.result as Placed | null)?.order
  const payments = await paymentStatus(prisma, request.organizationId)
  return { state: 'placed', order: { ...(latestOrder ?? placed.order), paymentsAvailable: reachable && !node?.handoverRequestedAt && payments.active && payments.channels.includes('qr') }, branchOffline: !reachable, dataReceivedThrough: latest?.completedAt ?? request.completedAt }
}

// Branch PC side: executes claimed commands in-process against the local ERP.
type Outcome = { status: number; result: unknown } | null
export async function executeBranchCommand(command: { kind: string; payload: Record<string, unknown> }, branchId: string): Promise<Outcome> {
  try {
    if (transferKinds.includes(command.kind as typeof transferKinds[number])) return { status: 200, result: await applyStockTransfer(command.kind, command.payload, branchId) }
    if (command.kind === 'payment-settle') return { status: 200, result: await applyBranchPayment(command.payload, branchId) }
    if (command.kind === 'online-place') {
      const { created, order } = await placeOnlineOrder(branchId, onlineOrderSchema.parse(command.payload))
      return { status: created ? 201 : 200, result: { order: publicOrder(order) } }
    }
    const orderId = command.payload.orderId
    if (typeof orderId !== 'string' || !/^online-[a-f0-9]{64}$/.test(orderId)) return { status: 400, result: { message: 'Invalid order reference', code: 'COMMAND_INVALID' } }
    const order = await trackedOnlineOrder(orderId)
    if (order.branchId !== branchId) return { status: 404, result: { message: 'Order not found', code: 'ORDER_NOT_FOUND' } }
    return { status: 200, result: { order: await onlineOrderView(order) } }
  } catch (error) {
    if (error instanceof ZodError) return { status: 400, result: { message: 'The order details were invalid. Please update your cart and try again.', code: 'VALIDATION_ERROR' } }
    if (error instanceof AppError && error.statusCode < 500) return { status: error.statusCode, result: { message: error.message, code: error.code } }
    // Unknown failure: it may have committed. Leave unacknowledged so the
    // lease expires and the same idempotent request is replayed.
    return null
  }
}

let processing = false
export async function processBranchOnlineCommands() {
  if (processing || process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  if (!endpoint || !token || new URL(endpoint).protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && new URL(endpoint).hostname === '127.0.0.1')) return
  processing = true
  try {
    const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
    if (!runtime) return
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const claimed = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/commands/claim`, { method: 'POST', headers, body: '{}', redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (claimed.status === 410 && (await claimed.json().catch(() => null) as { code?: string } | null)?.code === 'BRANCH_RELEASED') { await freezeReleased(); return false }
    if (!claimed.ok) return false
    const body = await claimed.json() as { handoverRequested?: boolean; commands: { id: string; kind: string; branchId: string; organizationId: string; claimToken: string; payload: Record<string, unknown> }[] }
    if (!Array.isArray(body.commands) || body.commands.length > 10) return false
    for (const command of body.commands) {
      if (command.branchId !== runtime.branchId || command.organizationId !== runtime.organizationId || !['online-place', 'online-status', 'payment-settle', ...transferKinds].includes(command.kind)) continue
      const outcome = await executeBranchCommand(command, runtime.branchId)
      if (!outcome) continue
      await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/commands/${encodeURIComponent(command.id)}/complete`, { method: 'POST', headers, body: JSON.stringify({ claimToken: command.claimToken, ...outcome }), redirect: 'error', signal: AbortSignal.timeout(15000) })
    }
    // Hand over only once the cloud queue is empty for this PC.
    await flushBranchRefunds().catch(() => undefined)
    await flushBranchWallets().catch(() => undefined)
    if (body.handoverRequested && !body.commands.some(c => ['online-place', 'payment-settle', ...transferKinds].includes(c.kind))) await advanceHandover(endpoint, token)
    return true
  } catch { return false /* The durable queue retains unacknowledged commands. */ } finally { processing = false }
}
