import { PaymentIntent, Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { z } from 'zod'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { replicaDigest } from './branchReplica'
import { parseOnlineTrackingCode } from '../utils/onlineOrder'

const payloadSchema = z.object({
  intentId: z.string().min(1).max(100), orderId: z.string().min(1).max(100), checkId: z.string().max(100).nullable(),
  organizationId: z.string().min(1).max(100), branchId: z.string().min(1).max(100),
  amount: z.number().finite().positive().max(100000000), currency: z.string().min(1).max(10),
  adapter: z.string().min(1).max(40), environment: z.enum(['sandbox', 'production']),
  merchantId: z.string().max(200), counterCode: z.string().max(30), method: z.enum(['card', 'mada']),
  actorId: z.string().min(1).max(100), paidAt: z.string().datetime(),
}).strict()
export type BranchPaymentPayload = z.infer<typeof payloadSchema>

// The tracking capability is signed by the cloud; the order id comes from
// the branch's acknowledged placement, never from the payer's request body.
export async function relayedPaymentOrder(code: string) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return null
  const publicId = parseOnlineTrackingCode(code)
  if (!publicId) return null
  const receipt = await prisma.branchRemoteCommand.findFirst({ where: { publicId, kind: 'online-place' } })
  if (!receipt) return null
  const node = await prisma.branchSyncNode.findUnique({ where: { id: receipt.nodeId } })
  const result = receipt.result as { order?: { id?: string } } | null
  if (receipt.status !== 'completed' || !result?.order?.id || !node?.isActive || !node.ownsWrites || node.handoverRequestedAt || !node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > 45000) throw new AppError('The restaurant must be connected and confirm this order before online payment.', 409, 'BRANCH_PAYMENT_NOT_READY')
  const order = await prisma.customerOrder.findFirst({ where: { id: result.order.id, organizationId: receipt.organizationId, branchId: receipt.branchId } })
  if (!order) throw new AppError('The restaurant is still synchronizing this order. Please try payment again shortly.', 409, 'BRANCH_PAYMENT_SYNC_PENDING')
  return order.id
}

// Provider verification stays in payments/index.ts. Only already verified,
// exactly matched funds reach this function. The cloud never posts to a
// branch-owned ledger: it commits a durable settlement command instead.
export async function queueBranchPayment(intent: PaymentIntent, method: 'card' | 'mada' = 'card') {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return false
  const node = await prisma.branchSyncNode.findFirst({ where: { organizationId: intent.organizationId, branchId: intent.branchId, ownsWrites: true } })
  if (!node) return false
  const { systemRequest } = await import('./payments')
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${node.branchId}`}))`
    const owner = await tx.branchSyncNode.findUnique({ where: { id: node.id } })
    if (!owner?.ownsWrites) throw new AppError('Branch ownership changed while confirming payment. Retry the callback.', 409, 'BRANCH_PAYMENT_OWNER_CHANGED')
    const fresh = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
    if (fresh.settledAt || fresh.status === 'awaiting_branch') return true
    if (!['created', 'pending'].includes(fresh.status)) throw new AppError('Review and refund this late payment; its payment attempt was stopped.', 409, 'PAYMENT_STOPPED')
    const actor = await systemRequest(tx, intent.organizationId)
    const payload: BranchPaymentPayload = { intentId: intent.id, orderId: intent.orderId, checkId: intent.checkId, organizationId: intent.organizationId, branchId: intent.branchId, amount: intent.amount, currency: intent.currency, adapter: intent.adapter, environment: intent.environment as 'sandbox' | 'production', merchantId: intent.merchantId, counterCode: intent.counterCode, method, actorId: actor.user.id, paidAt: new Date().toISOString() }
    const key = `payment-settle:${intent.id}`
    const prior = await tx.branchRemoteCommand.findUnique({ where: { nodeId_key: { nodeId: node.id, key } } })
    if (!prior) await tx.branchRemoteCommand.create({ data: { nodeId: node.id, organizationId: intent.organizationId, branchId: intent.branchId, key, publicId: intent.id, kind: 'payment-settle', digest: replicaDigest(payload), payload, expiresAt: new Date('9999-01-01T00:00:00Z') } })
    await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'awaiting_branch', failureReason: 'Gateway payment confirmed. Waiting for the branch to record it.' } })
    return true
  })
}

export async function applyBranchPayment(input: unknown, branchId: string) {
  const payload = payloadSchema.parse(input)
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || runtime.branchId !== branchId || payload.branchId !== runtime.branchId || payload.organizationId !== runtime.organizationId) throw new AppError('Payment belongs to another branch', 403, 'BRANCH_FORBIDDEN')
  const { settle, afterSettle, SYSTEM_EMAIL_DOMAIN } = await import('./payments')
  const digest = replicaDigest(payload)
  let applied: PaymentIntent | undefined
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-payment:${payload.intentId}`}))`
    const previous = await tx.paymentIntent.findUnique({ where: { id: payload.intentId } })
    if (previous) {
      if (previous.idempotencyKey !== digest || previous.organizationId !== runtime.organizationId || previous.branchId !== branchId) throw new AppError('Payment receipt changed', 409, 'PAYMENT_REPLAY_CONFLICT')
      if (previous.settledAt) { applied = previous; return }
    }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: runtime.organizationId } })
    if (org.currency !== payload.currency) throw new AppError('Payment currency differs from this branch', 409, 'PAYMENT_CURRENCY_MISMATCH')
    const order = await tx.customerOrder.findFirst({ where: { id: payload.orderId, organizationId: runtime.organizationId, branchId } })
    if (!order) throw new AppError('Payment order was not found at this branch', 404, 'ORDER_NOT_FOUND')
    const email = `payments-${org.id}${SYSTEM_EMAIL_DOMAIN}`
    const actor = await tx.user.findUnique({ where: { organizationId_email: { organizationId: org.id, email } } })
    if (actor && actor.id !== payload.actorId) throw new AppError('The branch payment actor requires reconciliation', 409, 'PAYMENT_ACTOR_CONFLICT')
    if (!actor) await tx.user.create({ data: { id: payload.actorId, organizationId: org.id, email, passwordHash: '!', firstName: 'Online', lastName: 'payments', isActive: false } })
    const intent = previous ?? await tx.paymentIntent.create({ data: { id: payload.intentId, organizationId: org.id, branchId, orderId: payload.orderId, checkId: payload.checkId, channel: 'qr', adapter: payload.adapter, environment: payload.environment, amount: payload.amount, currency: payload.currency, merchantId: payload.merchantId, counterCode: payload.counterCode, accessTokenHash: '!', idempotencyKey: digest, expiresAt: new Date('9999-01-01T00:00:00Z') } })
    await settle(tx, intent, payload.method, new Date(payload.paidAt))
    applied = await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'succeeded', settledAt: new Date(), failureReason: null } })
  }, { timeout: 30000 })
  await afterSettle(applied!)
  return { applied: true, intentId: payload.intentId, settledAt: applied!.settledAt!.toISOString() }
}

// Runs inside the same transaction that commits the command receipt. A lost
// HTTP acknowledgment cannot change money or accounting a second time.
export async function acknowledgeBranchPayment(tx: Prisma.TransactionClient, command: { kind: string; payload: Prisma.JsonValue; organizationId: string; branchId: string }, response: { status: number; result: unknown }) {
  if (command.kind !== 'payment-settle') return
  const payload = payloadSchema.parse(command.payload)
  const result = z.object({ applied: z.boolean().optional(), intentId: z.string().optional(), settledAt: z.string().datetime().optional(), message: z.string().max(500).optional() }).passthrough().parse(response.result)
  const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: payload.intentId } })
  if (intent.organizationId !== command.organizationId || intent.branchId !== command.branchId || intent.orderId !== payload.orderId || Math.abs(intent.amount - payload.amount) > 0.005 || intent.currency !== payload.currency) throw new AppError('Payment acknowledgment differs from the intent', 409, 'PAYMENT_REPLAY_CONFLICT')
  if (intent.settledAt) return
  if (response.status < 300 && result.applied === true && result.intentId === intent.id && result.settledAt) await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'succeeded', settledAt: new Date(result.settledAt), failureReason: null } })
  else await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'needs_review', failureReason: result.message ?? 'Gateway funds could not be applied at the branch. Review the order and refund if necessary.' } })
}

export async function branchRefund(token: string, id: string) {
  const node = await prisma.branchSyncNode.findFirst({ where: { tokenHash: createHash('sha256').update(token).digest('hex'), isActive: true, ownsWrites: true } })
  if (!node) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  const intent = await prisma.paymentIntent.findFirst({ where: { id, organizationId: node.organizationId, branchId: node.branchId, status: 'succeeded' } })
  if (!intent) throw new AppError('Settled branch payment not found', 404, 'NOT_FOUND')
  const refunded = intent.checkId
    ? await prisma.orderCheck.count({ where: { id: intent.checkId, orderId: intent.orderId, status: 'refunded' } })
    : await prisma.customerOrder.count({ where: { id: intent.orderId, organizationId: node.organizationId, branchId: node.branchId, status: 'refunded' } })
  if (!refunded) throw new AppError('The branch refund must synchronize before gateway funds can be returned.', 409, 'BRANCH_REFUND_SYNC_PENDING')
  const { refundIntent } = await import('./payments')
  const updated = await refundIntent(intent)
  return { id: updated.id, refundStatus: updated.refundStatus, refundedAmount: updated.refundedAmount }
}

let refunding = false
export async function flushBranchRefunds() {
  if (refunding || process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  if (!endpoint || !token || new URL(endpoint).protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && new URL(endpoint).hostname === '127.0.0.1')) return
  refunding = true
  try {
    const intents = await prisma.paymentIntent.findMany({ where: { status: 'succeeded', refundStatus: { in: ['pending', 'failed'] } }, take: 20 })
    for (const intent of intents) {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/payments/${encodeURIComponent(intent.id)}/refund`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(30000) })
      if (!response.ok) continue
      const result = z.object({ id: z.literal(intent.id), refundStatus: z.enum(['pending', 'failed', 'refunded']), refundedAmount: z.number().finite().min(0) }).parse(await response.json())
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { refundStatus: result.refundStatus, refundedAmount: result.refundedAmount } })
    }
  } finally { refunding = false }
}
