import { validMoneyPrecision, moneyFactor } from '../../utils/money'
import { moneyTolerance as regionalMoneyTolerance } from '../../utils/money'
import { roundMoney as regionalRoundMoney } from '../../utils/money'
import { assertReadyForPayment } from '../orderPaymentPolicy'
import { assertCounter } from '../posCounters'
import crypto from 'node:crypto'
import { Prisma, PaymentIntent } from '@prisma/client'
import { Request } from 'express'
import { prisma, config } from '../../config'
import { AppError } from '../../middleware/error'
import { logAudit } from '../../utils/audit'
import { publish } from '../../utils/liveEvents'
import { AdapterContext, CallbackRejected, Channel, adapterFor, VerifiedEvent } from './adapters'

type Tx = Prisma.TransactionClient
const round2 = (n: number) => regionalRoundMoney(n)
const INTENT_MINUTES = 20
export const SYSTEM_EMAIL_DOMAIN = '@system.foodsync.invalid'
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
// Reproducible for retries, bound to this intent and its revocable random seed.
// Neither plaintext bearer tokens nor a new schema column are needed. Existing
// random tokens remain valid against their original stored hash.
const accessFor = (intent: Pick<PaymentIntent, 'id' | 'accessTokenHash'>) => `v1_${crypto.createHmac('sha256', config.jwtSecret).update(`payment-access:v1:${intent.id}:${intent.accessTokenHash}`).digest('base64url')}`
const equalToken = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function openSecret(sealed: string | null) {
  if (!sealed) return null
  try {
    const [iv, tag, data] = sealed.split('.').map((v) => Buffer.from(v, 'base64'))
    const key = crypto.createHash('sha256').update(process.env.PAYMENT_ENCRYPTION_KEY || `payments:${config.jwtSecret}`).digest()
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString('utf8')
  } catch { return null }
}

// Is a payment integration usable for this organization, and for what?
export async function paymentStatus(db: Tx | typeof prisma, organizationId: string) {
  const [settings, org] = await Promise.all([
    db.commerceSettings.findUnique({ where: { organizationId } }),
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } }),
  ])
  const key = settings?.paymentAdapter ?? 'none'
  const adapter = key === 'none' ? null : adapterFor(key)
  const environment = (settings?.paymentEnvironment ?? 'sandbox') as 'sandbox' | 'production'
  let reason: string | null = null
  if (!adapter) reason = key === 'none' ? 'No payment integration is selected. Payments are taken at the till.' : 'The selected integration is not available in this version.'
  else if (adapter.sandboxOnly && environment !== 'sandbox') reason = `${adapter.label} only works in the sandbox environment.`
  if (key === 'moyasar' && org.currency !== 'SAR') reason = 'Set the organization currency to SAR for MADA checkout.'
  if (key === 'moyasar' && !openSecret(settings?.secretSealed ?? null)?.startsWith(environment === 'production' ? 'sk_live_' : 'sk_test_')) reason = 'Enter the matching Moyasar secret key in payment settings.'
  if (key === 'moyasar' && !process.env.PAYMENT_CALLBACK_BASE_URL?.startsWith('https://')) reason = 'Configure the public HTTPS payment callback API URL.'
  const active = !!adapter && !reason
  return {
    adapter: key, label: adapter?.label ?? 'None', environment, active, reason, live: active && environment === 'production' && !adapter?.sandboxOnly,
    channels: active ? adapter!.channels : [] as Channel[], currency: org.currency,
    context: active ? { organizationId, environment, merchantId: settings?.merchantId ?? '', currency: org.currency, secret: openSecret(settings?.secretSealed ?? null) } as AdapterContext : null,
  }
}

// The organization's "Online payments" actor: an inactive account that can
// never log in, used to record payments that arrive without a cashier.
export async function systemRequest(tx: Tx, organizationId: string): Promise<Request> {
  const email = `payments-${organizationId}${SYSTEM_EMAIL_DOMAIN}`
  // safe when two first payments of an organization arrive together
  await tx.$executeRaw`INSERT INTO "User" (id, "organizationId", email, "passwordHash", "firstName", "lastName", "isActive", "createdAt", "updatedAt")
    VALUES (${`sys_${crypto.randomUUID()}`}, ${organizationId}, ${email}, '!', 'Online', 'payments', false, now(), now())
    ON CONFLICT ("organizationId", email) DO NOTHING`
  const user = await tx.user.findUniqueOrThrow({ where: { organizationId_email: { organizationId, email } } })
  return { user: { id: user.id, organizationId, email }, ip: 'payment-callback', headers: {}, get: () => undefined } as unknown as Request
}

// What is still to pay on the order, or on one check
export async function amountDue(tx: Tx, orderId: string, checkId?: string | null) {
  if (checkId) {
    const check = await tx.orderCheck.findFirst({ where: { id: checkId, orderId } })
    if (!check) throw new AppError('Check not found', 404, 'NOT_FOUND')
    if (check.status !== 'unpaid') throw new AppError('This check is already paid', 409, 'CHECK_ALREADY_PAID')
    return round2(check.totalAmount)
  }
  if (await tx.orderCheck.count({ where: { orderId } })) throw new AppError('This bill has separate checks; pay one check', 409, 'CHECKS_EXIST')
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } })
  return round2(order.totalAmount)
}

// Create (or reuse) a payment attempt. The amount always comes from the
// server's own totals, never from the payer.
export async function createIntent(input: { organizationId: string; branchId: string; orderId: string; checkId?: string | null; channel: Channel; createdBy?: string | null; counterCode?: string }) {
  const status = await paymentStatus(prisma, input.organizationId)
  if (!status.active || !status.context) throw new AppError(status.reason ?? 'Payments are not available', 409, 'PAYMENTS_UNAVAILABLE')
  if (!status.channels.includes(input.channel)) throw new AppError('This payment integration does not support this channel', 409, 'PAYMENTS_UNAVAILABLE')
  const adapter = adapterFor(status.adapter)!
  const accessToken = crypto.randomBytes(24).toString('base64url')
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-intent:${input.orderId}`}))`
    const { lockOrder } = await import('../../routes/orders')
    const found = await tx.customerOrder.findUniqueOrThrow({ where: { id: input.orderId } })
    await lockOrder(tx, found)
    const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: input.orderId }, include: { items: true } })
    if (order.organizationId !== input.organizationId || order.branchId !== input.branchId) throw new AppError('Order not found', 404, 'NOT_FOUND')
    if (!(order.source === 'kiosk' && order.status === 'pending')) assertReadyForPayment(order)
    if (!['open', 'pending'].includes(order.status)) throw new AppError('This order is not open for payment', 409, 'INVALID_STATUS')
    const counterCode = input.counterCode ?? order.counterCode
    await assertCounter(tx, order, counterCode)
    const amount = await amountDue(tx, input.orderId, input.checkId)
    if (amount < regionalMoneyTolerance()) throw new AppError('Nothing to pay', 409, 'NOTHING_DUE')
    // a payment already under way for the same bill is reused, never doubled
    const live = await tx.paymentIntent.findFirst({ where: { orderId: input.orderId, checkId: input.checkId ?? null, OR: [{ status: { in: ['created', 'pending'] }, expiresAt: { gt: new Date() } }, { status: 'awaiting_branch' }] } })
    if (live?.status === 'awaiting_branch') return live
    if (live && Math.abs(live.amount - amount) < 0.005 && live.channel === input.channel && live.counterCode === counterCode) {
      return live
    }
    if (live) await tx.paymentIntent.update({ where: { id: live.id }, data: { status: 'cancelled', failureReason: 'Replaced by a new payment for the current amount' } })
    if (await tx.paymentIntent.count({ where: { orderId: input.orderId, checkId: input.checkId ?? null, status: { in: ['succeeded', 'needs_review'] }, refundStatus: 'none' } })) throw new AppError('A payment for this bill was already received', 409, 'ALREADY_PAID')
    return tx.paymentIntent.create({ data: {
      organizationId: input.organizationId, branchId: input.branchId, orderId: input.orderId, checkId: input.checkId ?? null, channel: input.channel,
      counterCode, adapter: adapter.key, environment: status.environment, amount, currency: status.currency, merchantId: status.context!.merchantId,
      accessTokenHash: hash(accessToken), idempotencyKey: crypto.randomUUID(), createdBy: input.createdBy ?? null, expiresAt: new Date(Date.now() + INTENT_MINUTES * 60_000),
    } })
  })
  if (!result.providerRef) {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${result.id} FOR UPDATE`
      const fresh = await tx.paymentIntent.findUniqueOrThrow({ where: { id: result.id } })
      if (fresh.providerRef) return fresh
      if (fresh.status !== 'created') throw new AppError('This payment attempt is no longer open', 409, 'INVALID_STATUS')
      const created = await adapter.create(status.context!, { id: fresh.id, amount: fresh.amount, currency: fresh.currency, channel: input.channel, providerRef: null })
      return tx.paymentIntent.update({ where: { id: result.id }, data: { providerRef: created.providerRef, checkoutUrl: created.checkoutUrl ?? null, status: 'pending' } })
    }, { timeout: 25000 })
    return { intent: updated, accessToken: accessFor(updated) }
  }
  return { intent: result, accessToken: accessFor(result) }
}

export async function intentByToken(id: string, token: string) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id } })
  if (!intent || !token || intent.accessTokenHash === '!' || (!equalToken(intent.accessTokenHash, hash(token)) && !equalToken(accessFor(intent), token))) throw new AppError('Payment not found', 404, 'NOT_FOUND')
  return intent
}

export const publicIntent = (i: PaymentIntent) => ({ checkoutUrl: i.checkoutUrl, id: i.id, status: i.status, amount: i.amount, currency: i.currency, channel: i.channel, adapter: i.adapter, environment: i.environment, expiresAt: i.expiresAt, failureReason: i.status === 'failed' ? i.failureReason : null, orderId: i.orderId, checkId: i.checkId })

// Apply verified money to the order or check, inside one transaction.
export async function settle(tx: Tx, intent: PaymentIntent, method: 'card' | 'mada' = 'card', paidAt?: Date) {
  const req = await systemRequest(tx, intent.organizationId)
  const { completeOrderInTransaction, completeOrderSchema, lockOrder } = await import('../../routes/orders')
  const { payCheck } = await import('../orderChecks')
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: intent.orderId } })
  const payments = [{ method, amount: intent.amount }]
  if (intent.checkId) {
    await payCheck(tx, req, order.id, intent.checkId, { payments, counterCode: intent.counterCode })
    return
  }
  if (order.status === 'pending' && order.source !== 'kiosk') throw new AppError('Staff must accept this order before payment', 409, 'NOT_ACCEPTED')
  if (order.status === 'pending') {
    // a kiosk order goes to the kitchen once it is paid
    await lockOrder(tx, order)
    await tx.customerOrder.update({ where: { id: order.id }, data: { status: 'open', acceptedAt: new Date(), acceptedBy: req.user.id } })
  }
  await completeOrderInTransaction(tx, req, order, completeOrderSchema.parse({ counterCode: intent.counterCode, paymentMethod: method, payments, discountAmount: order.discountAmount, discountReason: order.discountReason }), paidAt)
}

// A callback from an integration: verify, record once, settle once.
export async function handleCallback(adapterKey: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
  const adapter = adapterFor(adapterKey)
  if (!adapter) throw new AppError('Unknown payment integration', 404, 'NOT_FOUND')
  let event: VerifiedEvent
  try {
    event = await adapter.verifyCallback(headers, rawBody, async (organizationId) => (await paymentStatus(prisma, organizationId).catch(() => null))?.context ?? null)
    if (!Number.isFinite(event.amount) || event.amount <= 0 || !Number.isSafeInteger(Math.round(event.amount * moneyFactor(event.currency))) || !validMoneyPrecision(event.amount, event.currency) || !event.currency || typeof event.merchantId !== 'string') {
      throw new CallbackRejected('Invalid callback amount or currency', 'INVALID_PAYLOAD')
    }
  } catch (e) {
    if (e instanceof CallbackRejected) {
      if (e.code === 'PAYMENT_PENDING') throw new AppError(e.message, 409, e.code)
      await prisma.paymentEvent.create({ data: { adapter: adapterKey, providerEventId: `rejected:${crypto.randomUUID()}`, type: 'unknown', signatureValid: false, outcome: e.code, payloadHash: hash(rawBody.toString('utf8')) } })
      throw new AppError(e.message, 401, e.code)
    }
    throw e
  }
  // one row per provider event: a repeated delivery changes nothing
  const intent = await prisma.paymentIntent.findFirst({ where: { adapter: adapterKey, providerRef: event.providerRef, organizationId: event.organizationId } })
  const inserted = await prisma.paymentEvent.createMany({ data: [{ organizationId: event.organizationId, intentId: intent?.id ?? null, adapter: adapterKey, providerEventId: event.eventId, type: event.type, signatureValid: true, outcome: intent ? 'received' : 'unknown_payment', payloadHash: hash(rawBody.toString('utf8')) }], skipDuplicates: true })
  if (!inserted.count) {
    const prior = await prisma.paymentEvent.findUnique({ where: { adapter_providerEventId: { adapter: adapterKey, providerEventId: event.eventId } } })
    // A crash after recording the verified event must not permanently swallow
    // the payment. Retry an unfinished event, preserving completed receipts.
    if (prior?.outcome !== 'received') return { outcome: 'duplicate' as const, intent }
  }
  if (!intent) return { outcome: 'unknown_payment' as const, intent: null }
  const mark = (outcome: string) => prisma.paymentEvent.update({ where: { adapter_providerEventId: { adapter: adapterKey, providerEventId: event.eventId } }, data: { outcome } })

  // amount, currency and merchant must be exactly what was asked for
  const mismatch = Math.abs(event.amount - intent.amount) > 0.005 ? 'amount' : event.currency !== intent.currency ? 'currency' : (intent.merchantId && event.merchantId !== intent.merchantId) ? 'merchant' : null
  if (mismatch) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: event.type === 'payment.succeeded' ? 'needs_review' : intent.status, failureReason: `The gateway reported a different ${mismatch}` } })
    await mark(`mismatch_${mismatch}`)
    return { outcome: 'mismatch' as const, intent }
  }
  if (event.type === 'refund.succeeded' || event.type === 'refund.failed') {
    // This integration currently supports full refunds only. Validate against
    // the captured amount above and serialize refunds with payment settlement.
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intent.id} FOR UPDATE`
      const fresh = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      let outcome: string
      if (fresh.refundStatus === 'refunded') outcome = 'already_refunded'
      else if (fresh.status !== 'succeeded' || fresh.refundStatus !== 'pending') outcome = 'unexpected_refund'
      else {
        await tx.paymentIntent.update({ where: { id: intent.id }, data: event.type === 'refund.succeeded' ? { refundStatus: 'refunded', refundedAmount: event.amount, failureReason: null } : { refundStatus: 'failed', failureReason: event.reason ?? 'Refund failed' } })
        outcome = event.type
      }
      await tx.paymentEvent.update({ where: { adapter_providerEventId: { adapter: adapterKey, providerEventId: event.eventId } }, data: { outcome } })
      return { outcome, intent: fresh }
    })
  }
  if (event.type === 'payment.failed') {
    await prisma.paymentIntent.updateMany({ where: { id: intent.id, status: { in: ['created', 'pending'] } }, data: { status: 'failed', failureReason: event.reason ?? 'Payment declined' } })
    await mark('failed')
    return { outcome: 'failed' as const, intent }
  }

  const { queueBranchPayment } = await import('../branchPayments')
  try {
    if (await queueBranchPayment(intent, event.method)) {
      await mark('awaiting_branch')
      return { outcome: 'awaiting_branch' as const, intent }
    }
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode >= 500 || error.code === 'BRANCH_PAYMENT_OWNER_CHANGED') throw error
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'needs_review', failureReason: error.message } })
    await mark('needs_review')
    return { outcome: 'needs_review' as const, intent }
  }

  // payment.succeeded: settle under the intent's row lock
  let settledNow = false
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intent.id} FOR UPDATE`
      const fresh = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
      if (fresh.settledAt) return
      if (!['created', 'pending'].includes(fresh.status)) throw new AppError('This payment attempt was stopped; review and refund the late payment', 409, 'PAYMENT_STOPPED')
      await settle(tx, fresh, event.method)
      await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'succeeded', settledAt: new Date(), failureReason: null } })
      settledNow = true
    }, { timeout: 30_000 })
  } catch (e) {
    // paid at the gateway but the bill changed or closed: a person decides
    const reason = e instanceof AppError ? e.message : 'The payment could not be applied to the bill'
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'needs_review', failureReason: reason } })
    await mark('needs_review')
    publish({ topic: 'order', action: 'payment_review', organizationId: intent.organizationId, branchId: intent.branchId, orderId: intent.orderId })
    return { outcome: 'needs_review' as const, intent }
  }
  await mark(settledNow ? 'settled' : 'already_settled')
  if (settledNow) await afterSettle(intent)
  return { outcome: 'settled' as const, intent }
}

export async function afterSettle(intent: PaymentIntent) {
  const { issueForOrder } = await import('../zatca')
  const { publishOrder } = await import('../../routes/orders')
  const order = await prisma.customerOrder.findUniqueOrThrow({ where: { id: intent.orderId }, include: { table: { select: { name: true } } } })
  await issueForOrder(order.id, 'invoice', undefined, intent.checkId ?? undefined).catch((e) => console.error('[zatca] invoice for online payment not issued', intent.id, e))
  publishOrder(order, intent.checkId ? 'check_paid' : 'completed')
  publish({ topic: 'sale', action: 'updated', organizationId: order.organizationId, branchId: order.branchId })
}

// After an order (or its checks) is refunded in FoodSync, return the money
// taken through the integration. Never blocks the refund; failures stay
// visible on the Payments page to retry.
export async function refundIntentsForOrder(orderId: string) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    await prisma.paymentIntent.updateMany({ where: { orderId, status: 'succeeded', refundStatus: { in: ['none', 'failed'] } }, data: { refundStatus: 'pending', failureReason: 'Refund queued for the cloud payment provider.' } })
    return
  }
  const intents = await prisma.paymentIntent.findMany({ where: { orderId, status: 'succeeded', refundStatus: { in: ['none', 'failed'] } } })
  for (const intent of intents) await refundIntent(intent)
}

export async function refundIntent(intent: PaymentIntent) {
  const adapter = adapterFor(intent.adapter)
  const status = await paymentStatus(prisma, intent.organizationId)
  if (!adapter || !status.context || status.adapter !== intent.adapter) {
    return prisma.paymentIntent.update({ where: { id: intent.id }, data: { refundStatus: 'failed', failureReason: 'The payment integration is no longer active; refund it in the provider’s dashboard' } })
  }
  // claim the refund so two refunds of the same payment cannot both run
  const claimed = await prisma.paymentIntent.updateMany({ where: { id: intent.id, refundStatus: { in: ['none', 'failed'] } }, data: { refundStatus: 'pending' } })
  if (!claimed.count) return prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
  try {
    const r = await adapter.refund(status.context, { id: intent.id, amount: intent.amount, currency: intent.currency, channel: intent.channel as Channel, providerRef: intent.providerRef }, intent.amount, `refund:${intent.id}`)
    return prisma.paymentIntent.update({ where: { id: intent.id }, data: { refundStatus: r.status, refundRef: r.refundRef, ...(r.status === 'refunded' && { refundedAmount: intent.amount }), ...(r.reason && { failureReason: r.reason }) } })
  } catch (e) {
    return prisma.paymentIntent.update({ where: { id: intent.id }, data: { refundStatus: 'failed', failureReason: (e as Error).message.slice(0, 300) } })
  }
}

// Staff resolve a payment that could not be applied: the money is returned.
export async function refundReviewedIntent(req: Request, intentId: string) {
  const intent = await prisma.paymentIntent.findFirst({ where: { id: intentId, organizationId: req.user.organizationId } })
  if (!intent) throw new AppError('Payment not found', 404, 'NOT_FOUND')
  if (intent.status !== 'needs_review' && !(intent.status === 'succeeded' && intent.refundStatus === 'failed')) throw new AppError('Only payments that need review or whose refund failed can be refunded here', 409, 'INVALID_STATUS')
  const updated = await refundIntent(intent.status === 'needs_review' ? { ...intent } : intent)
  if (intent.status === 'needs_review' && updated.refundStatus === 'refunded') await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'cancelled' } })
  await logAudit(prisma, { req, action: 'refund_online_payment', module: 'payments', resourceType: 'payment_intent', resourceId: intent.id, branchId: intent.branchId, newData: { amount: intent.amount, refundStatus: updated.refundStatus } })
  return prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
}

// Staff took the money another way, or the order was cancelled: open
// attempts for that bill stop. A payer who still completes one at the gateway
// lands in "needs review" and is refunded from the Payments page.
export async function cancelOpenIntents(orderId: string, reason: string, checkId?: string) {
  await prisma.paymentIntent.updateMany({ where: { orderId, ...(checkId && { checkId }), status: { in: ['created', 'pending'] } }, data: { status: 'cancelled', failureReason: reason } })
}

export async function refreshProviderIntent(intent: PaymentIntent) {
  if (intent.adapter !== 'moyasar' || !intent.providerRef || !['created', 'pending', 'cancelled', 'expired'].includes(intent.status)) return intent
  await handleCallback('moyasar', {}, Buffer.from(JSON.stringify({ id: intent.providerRef, organizationId: intent.organizationId }))).catch((error) => {
    if (!(error instanceof AppError && error.code === 'PAYMENT_PENDING')) throw error
  })
  // Rotate background reconciliation fairly across pending and stopped attempts.
  await prisma.paymentIntent.update({ where: { id: intent.id }, data: { updatedAt: new Date() } })
  return prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
}
export function startPaymentWorker() {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const intents = await prisma.paymentIntent.findMany({ where: { adapter: 'moyasar', providerRef: { not: null }, status: { in: ['created', 'pending', 'cancelled', 'expired'] }, createdAt: { gte: new Date(Date.now() - 24 * 3600000) } }, orderBy: { updatedAt: 'asc' }, take: 50 })
      for (const intent of intents) await refreshProviderIntent(intent).catch(() => {})
    } catch (error) { console.error('[payments] reconciliation failed', error) } finally { running = false }
  }, 30000)
  timer.unref()
}
