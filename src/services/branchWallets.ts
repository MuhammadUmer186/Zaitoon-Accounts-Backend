import { moneyTolerance as regionalMoneyTolerance } from '../utils/money'
import { validMoneyPrecision } from '../utils/money'
import { roundMoney as regionalRoundMoney } from '../utils/money'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { Request } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { getUserPermissions } from '../utils/permissions'
import { assertBranchAccess } from '../utils/branchScope'
import { replicaDigest } from './branchReplica'
import type { TenderLine } from './tenders'

type Tx = Prisma.TransactionClient
const money = z.number().finite().positive().max(100000000).refine(n => validMoneyPrecision(n), "Use the selected currency decimal precision")
const payloadSchema = z.object({
  id: z.string().uuid(), orderId: z.string().min(1).max(150), reference: z.string().min(1).max(200), actorId: z.string().min(1).max(100),
  customer: z.object({ id: z.string().min(1).max(100), phone: z.string().min(7).max(40), name: z.string().min(1).max(120), email: z.string().email().nullable() }).strict().nullable(),
  lines: z.array(z.object({ method: z.enum(['gift_card', 'loyalty', 'house_account', 'cash', 'card', 'mada', 'bank_transfer', 'other']), amount: money, giftCardCode: z.string().trim().min(4).max(40).nullable().optional() }).strict()).max(6),
  // spend: pay with shared balances. earn: cash-sale loyalty points.
  // issue: gift card sold at the branch. settle: house-account payment taken
  // at the branch. legacy_refund: refund of a sale paid in the cloud before
  // this PC took over. Central effects of issue/settle/legacy_refund apply only
  // when the PC confirms its local receipt; nothing is given away before.
  kind: z.enum(['spend', 'earn', 'issue', 'settle', 'legacy_refund']),
  expiresAt: z.string().datetime().nullable().optional(),
  headRevision: z.string().regex(/^(-1|\d{1,18})$/), headDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  // Position of the PC's wallet sequence when this receipt was created.
  sequence: z.string().regex(/^\d{1,18}$/),
}).strict()
type Payload = z.infer<typeof payloadSchema>
const unavailable = () => new AppError('Shared balances require a connection to the cloud. Pay with cash or another available method; any unconfirmed reservation stays protected until recovery.', 503, 'SHARED_WALLET_OFFLINE')
const stored = (line: TenderLine) => ['gift_card', 'loyalty', 'house_account'].includes(line.method)
const GIFT_CODE = /^GC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/
const round2 = (n: number) => regionalRoundMoney(n)
function assertKind(body: Payload) {
  const ok = body.kind === 'spend' ? body.lines.some(stored)
    : body.kind === 'earn' ? body.lines.length > 0
    : body.kind === 'issue' ? body.lines.length === 1 && !stored(body.lines[0]) && GIFT_CODE.test(body.lines[0].giftCardCode ?? '') && body.lines[0].amount >= 1
    : body.kind === 'settle' ? body.lines.length === 1 && !stored(body.lines[0]) && !!body.customer
    : body.lines.length === 0
  if (!ok) throw new AppError('Invalid shared-wallet request', 400, 'WALLET_INVALID')
}

// Applies (commit) or undoes (release/refund) the central effect of a hold.
// The only place each kind's money movement is defined; automatic recovery
// and the operator panel both use it.
export async function applyHoldResolution(tx: Tx, req: Request, hold: { id: string; organizationId: string; orderId: string; reference: string; payload: Prisma.JsonValue }, action: 'commit' | 'release' | 'refund') {
  const p = hold.payload as unknown as Payload & { centralCustomerId?: string | null; giftCardId?: string }
  const tenders = await import('./tenders')
  if (p.kind === 'spend') {
    if (action !== 'commit') await tenders.creditTenders(tx, req, hold.organizationId, hold.orderId, `branch-wallet:${hold.id}`)
    return
  }
  if (action === 'refund') throw new AppError('Refund this through its own refund flow', 409, 'WALLET_RESOLUTION_CONFLICT')
  if (p.kind === 'issue') {
    await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${p.giftCardId!} FOR UPDATE`
    if (action === 'release') { await tx.giftCard.update({ where: { id: p.giftCardId! }, data: { status: 'void' } }); return }
    const card = await tx.giftCard.update({ where: { id: p.giftCardId! }, data: { status: 'active' } })
    await tx.giftCardTransaction.create({ data: { organizationId: hold.organizationId, giftCardId: card.id, type: 'issue', amount: card.initialAmount, balanceAfter: card.balance, referenceKey: `issue:${card.id}`, userId: req.user.id } })
    return
  }
  if (action === 'release') return // settle and legacy refunds change nothing until committed
  if (p.kind === 'settle') {
    const customerId = p.centralCustomerId!, amount = round2(p.lines[0].amount)
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } })
    // The money is already in the branch till. If other payments landed
    // meanwhile the account goes into credit rather than losing a payment.
    const balanceAfter = round2(customer.houseBalance - amount)
    await tx.customer.update({ where: { id: customerId }, data: { houseBalance: balanceAfter } })
    await tx.houseAccountTransaction.create({ data: { organizationId: hold.organizationId, customerId, type: 'payment', amount: -amount, balanceAfter, referenceKey: `payment:branch-wallet:${hold.id}`, userId: req.user.id } })
    return
  }
  // legacy_refund: reverse exactly what the cloud recorded for the sale.
  const original = hold.reference.slice('legacy-refund:'.length)
  if (original.startsWith('earn:')) await tenders.reverseLoyaltyEarn(tx, req, hold.organizationId, hold.orderId)
  else await tenders.creditTenders(tx, req, hold.organizationId, hold.orderId, original)
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const restoreDetected = () => new AppError('This PC was restored from an older backup. Shared balances are paused until a manager reviews its wallet activity in the cloud.', 409, 'WALLET_RESTORE_DETECTED')
const position = (value: unknown) => typeof value === 'string' && /^\d{1,18}$/.test(value) ? BigInt(value) : null

// Restore fence. The PC reports the position of its wallet sequence, which a
// rolled-back checkout never lowers but a restored backup does. A position
// below one the cloud has already seen means receipts the PC once had may be
// gone, so "no local receipt" no longer proves a rollback. Everything stops
// until an operator reviews the holds and accepts the restored position.
// fresh: the number was just allocated for this request, so it must be new.
async function fenceWallet(tx: Tx, node: { id: string; walletSequenceSeen: bigint; walletRestoreDetectedAt: Date | null }, reported: bigint | null, fresh = false) {
  if (reported === null) throw new AppError('Wallet position required', 400, 'WALLET_INVALID')
  if ((fresh ? reported <= node.walletSequenceSeen : reported < node.walletSequenceSeen) || node.walletRestoreDetectedAt) throw restoreDetected()
  await tx.$executeRaw`UPDATE "BranchSyncNode" SET "walletSequenceSeen" = GREATEST("walletSequenceSeen", ${reported}) WHERE "id" = ${node.id}`
}
// Records a detected restore outside the refused transaction.
async function guarded<T>(token: string, reported: bigint | null, work: () => Promise<T>) {
  try { return await work() } catch (error) {
    if ((error as AppError).code === 'WALLET_RESTORE_DETECTED' && reported !== null) {
      const node = await prisma.branchSyncNode.findFirst({ where: { tokenHash: hash(token), isActive: true, ownsWrites: true } })
      if (node && (reported <= node.walletSequenceSeen || node.walletRestoreDetectedAt)) await prisma.branchSyncNode.update({ where: { id: node.id }, data: { walletRestoreDetectedAt: node.walletRestoreDetectedAt ?? new Date(), walletSequenceReported: reported } })
    }
    throw error
  }
}

export async function walletNode(tx: Tx, token: string, lock = true) {
  const found = await tx.branchSyncNode.findFirst({ where: { tokenHash: hash(token), isActive: true, ownsWrites: true } })
  if (!found) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  if (lock) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${found.branchId}`}))`
  const node = await tx.branchSyncNode.findFirst({ where: { id: found.id, tokenHash: hash(token), isActive: true, ownsWrites: true } })
  if (!node || !await tx.branch.count({ where: { id: node.branchId, organizationId: node.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Invalid branch credentials', 401, 'BRANCH_UNAUTHORIZED')
  return node
}
async function actor(tx: Tx, node: { organizationId: string; branchId: string }, id: string, recovery = false) {
  const user = await tx.user.findFirst({ where: { id, organizationId: node.organizationId, isActive: true } })
  const access = user && await getUserPermissions(tx, id)
  if (!recovery && (!access || !['can_use_pos', 'can_manage_orders'].some(p => access.permissions.has(p)))) throw new AppError('Current cloud permission to take payment is required', 403, 'FORBIDDEN')
  if (!recovery) await assertBranchAccess({ user: { id, organizationId: node.organizationId } } as Request, node.branchId)
  // Recovery must return money even if the original employee has since left.
  const { systemRequest } = await import('./payments')
  return systemRequest(tx, node.organizationId)
}
async function centralCustomer(tx: Tx, org: string, contact: Payload['customer']) {
  if (!contact) return null
  const byId = await tx.customer.findUnique({ where: { id: contact.id } })
  if (byId && (byId.organizationId !== org || byId.phone !== contact.phone)) throw new AppError('Customer identity does not match the central wallet', 409, 'WALLET_CUSTOMER_CONFLICT')
  const byPhone = await tx.customer.findUnique({ where: { organizationId_phone: { organizationId: org, phone: contact.phone } } })
  if (byId || byPhone) return (byId ?? byPhone)!.id
  return (await tx.customer.create({ data: { id: contact.id, organizationId: org, phone: contact.phone, name: contact.name, email: contact.email } })).id
}

export async function reserveWallet(token: string, input: unknown) {
  const body = payloadSchema.parse(input)
  if (body.kind === 'earn') throw new AppError('Use the earnings endpoint', 400, 'WALLET_INVALID')
  assertKind(body)
  const reported = BigInt(body.sequence)
  return guarded(token, reported, () => prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-reserve:${body.id}`}))`
    const digest = replicaDigest(body), prior = await tx.branchWalletReservation.findUnique({ where: { id: body.id } })
    if (prior) {
      if (prior.nodeId !== node.id || prior.digest !== digest) throw new AppError('Wallet reservation changed', 409, 'WALLET_REPLAY_CONFLICT')
      if (prior.state !== 'reserved') throw new AppError('This reservation has already been resolved', 409, 'WALLET_RESOLVED')
      return { id: prior.id, digest, state: prior.state }
    }
    await fenceWallet(tx, node, reported, true)
    // One live or committed debit per payment reference (order or check). A
    // retry is accepted only once the earlier attempt is proven rolled back
    // and released by the PC.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-ref:${node.organizationId}:${body.reference}`}))`
    const live = await tx.branchWalletReservation.findFirst({ where: { organizationId: node.organizationId, reference: body.reference, id: { not: body.id }, state: { in: ['reserved', 'committed'] } } })
    if (live?.state === 'committed') throw new AppError('This payment was already taken from the customer\'s shared balance. Do not charge it again.', 409, 'WALLET_ALREADY_PAID')
    if (live) throw new AppError('An earlier attempt for this payment is still being confirmed.', 409, 'WALLET_PRIOR_PENDING')
    const req = await actor(tx, node, body.actorId), customerId = await centralCustomer(tx, node.organizationId, body.customer)
    if (body.headRevision !== node.replicaRevision.toString() || body.headDigest !== node.replicaDigest) throw new AppError('This PC must reconcile its checkpoint before spending shared balances', 409, 'WALLET_RECOVERY_REQUIRED')
    let giftCardId: string | undefined
    if (body.kind === 'spend') {
      const { debitTenders } = await import('./tenders')
      // Balance is withheld centrally immediately. No clock-driven expiry can
      // make money spendable while a disconnected PC may have committed it.
      await debitTenders(tx, req, { id: body.orderId, organizationId: node.organizationId, customerId }, body.lines, `branch-wallet:${body.id}`)
    } else if (body.kind === 'issue') {
      const code = body.lines[0].giftCardCode!
      if (await tx.giftCard.count({ where: { organizationId: node.organizationId, code } })) throw new AppError('Gift card code already exists; the PC chooses another', 409, 'GIFT_CARD_CODE_TAKEN')
      if (body.expiresAt && new Date(body.expiresAt) <= new Date()) throw new AppError('Choose an expiry date in the future', 400, 'VALIDATION_ERROR')
      // Not spendable until the branch confirms it took the money.
      giftCardId = (await tx.giftCard.create({ data: { organizationId: node.organizationId, code, customerId, initialAmount: round2(body.lines[0].amount), balance: round2(body.lines[0].amount), status: 'pending', expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, issuedBranchId: node.branchId, createdBy: body.actorId } })).id
    } else if (body.kind === 'settle') {
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId! } })
      if (!customer.houseAccountEnabled) throw new AppError('This customer has no house account', 409, 'HOUSE_ACCOUNT_DISABLED')
      if (body.lines[0].amount > round2(customer.houseBalance) + 0.0001) throw new AppError(`The account balance is ${round2(customer.houseBalance)}`, 409, 'OVERPAYMENT')
    } else {
      const original = body.reference.slice('legacy-refund:'.length)
      const found = original.startsWith('earn:')
        ? await tx.loyaltyTransaction.count({ where: { organizationId: node.organizationId, referenceKey: original } })
        : (await Promise.all([tx.giftCardTransaction, tx.loyaltyTransaction, tx.houseAccountTransaction].map(t => (t as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { organizationId: node.organizationId, orderId: body.orderId, referenceKey: { startsWith: `debit:${original}:` } } })))).reduce((a, b) => a + b, 0)
      if (!body.reference.startsWith('legacy-refund:') || !found) throw new AppError('The cloud has no shared-balance movement to refund for this sale', 404, 'WALLET_NOTHING_TO_REFUND')
    }
    await tx.branchWalletReservation.create({ data: { id: body.id, nodeId: node.id, organizationId: node.organizationId, branchId: node.branchId, orderId: body.orderId, reference: body.reference, digest, sequence: reported, payload: { ...body, centralCustomerId: customerId, ...(giftCardId && { giftCardId }) } } })
    return { id: body.id, digest, state: 'reserved' }
  }, { timeout: 20000 }))
}

export async function resolveWallet(token: string, input: unknown, reportedPosition?: unknown) {
  const body = z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['commit', 'release', 'refund']) }).strict().parse(input)
  const reported = position(reportedPosition)
  return guarded(token, reported, () => prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    await fenceWallet(tx, node, reported)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-reserve:${body.id}`}))`
    const hold = await tx.branchWalletReservation.findUnique({ where: { id: body.id } })
    if (!hold || hold.nodeId !== node.id || hold.digest !== body.digest) throw new AppError('Reservation not found', 404, 'NOT_FOUND')
    const allowed: Record<string, string[]> = { commit: ['reserved', 'committed'], release: ['reserved', 'released'], refund: ['reserved', 'committed', 'refunded'] }
    if (!allowed[body.action].includes(hold.state)) throw new AppError('Wallet resolution conflicts with its receipt', 409, 'WALLET_RESOLUTION_CONFLICT')
    const state = body.action === 'commit' ? 'committed' : body.action === 'release' ? 'released' : 'refunded'
    if (hold.state === state) return { id: hold.id, state }
    const req = await actor(tx, node, (hold.payload as unknown as Payload).actorId, true)
    await applyHoldResolution(tx, req, hold, body.action)
    await tx.branchWalletReservation.update({ where: { id: hold.id }, data: { state } })
    return { id: hold.id, state }
  }, { timeout: 20000 }))
}

export async function pendingWallets(token: string, reportedPosition?: unknown) {
  const reported = position(reportedPosition)
  return guarded(token, reported, () => prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    await fenceWallet(tx, node, reported)
    const pending = await tx.branchWalletReservation.findMany({ where: { nodeId: node.id, state: 'reserved' }, orderBy: { createdAt: 'asc' }, take: 100, select: { id: true, digest: true, reference: true } })
    return { pending, head: { revision: node.replicaRevision.toString(), digest: node.replicaDigest } }
  }))
}

export async function earnBranchWallet(token: string, input: unknown, reportedPosition?: unknown) {
  const data = z.object({ payload: payloadSchema, refunded: z.boolean() }).strict().parse(input), body = data.payload
  if (body.kind !== 'earn') throw new AppError('Invalid earnings receipt', 400, 'WALLET_INVALID')
  assertKind(body)
  // Earnings upload later than they were created: fence on the PC's current position.
  const reported = position(reportedPosition)
  return guarded(token, reported, () => prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    await fenceWallet(tx, node, reported)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-earn:${node.organizationId}:${body.orderId}`}))`
    const digest = replicaDigest(body), prior = await tx.branchWalletReservation.findUnique({ where: { id: body.id } })
    if (prior && (prior.nodeId !== node.id || prior.digest !== digest)) throw new AppError('Loyalty receipt changed', 409, 'WALLET_REPLAY_CONFLICT')
    const req = await actor(tx, node, body.actorId, true)
    const { earnLoyalty, reverseLoyaltyEarn } = await import('./tenders')
    if (!prior) {
      const customerId = await centralCustomer(tx, node.organizationId, body.customer)
      if (!data.refunded) await earnLoyalty(tx, req, { id: body.orderId, organizationId: node.organizationId, customerId }, body.lines)
      await tx.branchWalletReservation.create({ data: { id: body.id, nodeId: node.id, organizationId: node.organizationId, branchId: node.branchId, orderId: body.orderId, reference: body.reference, digest, payload: body, state: data.refunded ? 'refunded' : 'committed' } })
    } else if (data.refunded && prior.state !== 'refunded') {
      await reverseLoyaltyEarn(tx, req, node.organizationId, body.orderId)
      await tx.branchWalletReservation.update({ where: { id: body.id }, data: { state: 'refunded' } })
    }
    return { acknowledged: true }
  }, { timeout: 20000 }))
}

// Client calls never follow redirects or expose upstream response bodies or
// credentials on transport failures. A reservation with a lost response is
// discovered by the recovery worker, even if the local transaction rolled back.
export async function callWallet(route: string, body?: unknown) {
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  if (!endpoint || !token) throw unavailable()
  const origin = new URL(endpoint)
  if (origin.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && origin.hostname === '127.0.0.1')) throw unavailable()
  let response: globalThis.Response
  const [{ v: walletPosition }] = await prisma.$queryRaw<{ v: bigint }[]>`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS v FROM "BranchWalletSequence"`
  try { response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/wallets/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Wallet-Sequence': walletPosition.toString() }, ...(body !== undefined && { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(8000) }) } catch { throw unavailable() }
  if (!response.ok) {
    if (response.status >= 500) throw unavailable()
    const error = await response.json().catch(() => null) as { message?: string; code?: string } | null
    throw new AppError(error?.message ?? 'The central wallet refused this operation', response.status, error?.code ?? 'WALLET_REFUSED')
  }
  return response.json() as Promise<Record<string, unknown>>
}
export async function localWalletLock(tx: Tx) {
  const runtime = await tx.branchRuntime.findUniqueOrThrow({ where: { id: 'local' } })
  if (runtime.writesFrozen || runtime.replicaChainError) throw new AppError('Resolve branch ownership/recovery before using shared balances', 409, 'WALLET_RECOVERY_REQUIRED')
  // Consistent order with checkout ownership triggers and handover.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${runtime.branchId}`}))`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`local-wallet:${runtime.nodeId}`}))`
  return runtime
}
async function localPayload(tx: Tx, req: Request, order: { id: string; organizationId: string; customerId: string | null }, lines: TenderLine[], reference: string, kind: Payload['kind'], extra: { expiresAt?: string | null } = {}): Promise<Payload> {
  const customer = order.customerId ? await tx.customer.findFirst({ where: { id: order.customerId, organizationId: order.organizationId }, select: { id: true, phone: true, name: true, email: true } }) : null
  const runtime = await tx.branchRuntime.findUniqueOrThrow({ where: { id: 'local' } })
  // nextval is not transactional: a rolled-back checkout keeps its number.
  const [{ v: sequence }] = await tx.$queryRaw<{ v: bigint }[]>`SELECT nextval('"BranchWalletSequence"') AS v`
  return payloadSchema.parse({ id: randomUUID(), orderId: order.id, reference, actorId: req.user.id, customer, lines, kind, headRevision: runtime.lastReplicaRevision.toString(), headDigest: runtime.lastReplicaDigest, sequence: sequence.toString(), ...extra })
}
// Reserves a non-spend hold, the cloud validating it before any money changes
// hands locally. The caller writes its local records and the receipt in the
// same transaction; the central effect applies when the receipt is confirmed.
// Reserves under the local wallet lock. If an earlier attempt for the same
// reference is unresolved, the cloud has just accepted our sequence position,
// so a missing local receipt proves that attempt rolled back: release it and
// retry with a fresh number (the calls advanced the cloud's position).
async function reservePayload(tx: Tx, reference: string, makePayload: () => Promise<Payload>) {
  let payload = await makePayload()
  let result: Record<string, unknown>
  try { result = await callWallet('reserve', payload) } catch (error) {
    if ((error as AppError).code !== 'WALLET_PRIOR_PENDING') throw error
    const { pending } = await callWallet('pending') as unknown as { pending: { id: string; digest: string; reference: string }[] }
    for (const hold of pending.filter(h => h.reference === reference)) {
      if (await tx.branchWalletReceipt.findUnique({ where: { id: hold.id } })) throw new AppError('This was already recorded against the customer\'s shared balance. Do not take it again.', 409, 'WALLET_ALREADY_PAID')
      await callWallet('resolve', { id: hold.id, digest: hold.digest, action: 'release' })
    }
    payload = await makePayload()
    result = await callWallet('reserve', payload)
  }
  if (result.id !== payload.id || result.digest !== replicaDigest(payload) || result.state !== 'reserved') throw unavailable()
  return payload
}
async function reserveHold(tx: Tx, req: Request, order: { id: string; organizationId: string; customerId: string | null }, lines: TenderLine[], reference: string, kind: Payload['kind'], extra: { expiresAt?: string | null } = {}) {
  const runtime = await localWalletLock(tx)
  const payload = await reservePayload(tx, reference, () => localPayload(tx, req, order, lines, reference, kind, extra))
  await tx.branchWalletReceipt.create({ data: { id: payload.id, organizationId: runtime.organizationId, branchId: runtime.branchId, orderId: order.id, reference, payload } })
  return { runtime, payload }
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newGiftCode = () => 'GC-' + Array.from(randomBytes(8), b => ALPHABET[b % ALPHABET.length]).join('').replace(/(.{4})(.{4})/, '$1-$2')

// Gift card sold at the branch: money into the till and the liability journal
// locally; the card exists centrally but cannot be spent until confirmed.
export async function sellGiftCardAtBranch(req: Request, input: { requestId: string; method: string; amount: number; customerId?: string | null; expiresAt?: string | null }) {
  const reference = `gift-card:${input.requestId}`
  return prisma.$transaction(async tx => {
    await localWalletLock(tx)
    const prior = await tx.branchWalletReceipt.findFirst({ where: { reference } })
    if (prior) {
      const p = payloadSchema.parse(prior.payload)
      if (p.lines[0].method !== input.method || Math.abs(p.lines[0].amount - input.amount) > regionalMoneyTolerance() || (p.customer?.id ?? null) !== (input.customerId ?? null)) throw new AppError('This request ID was already used for a different receipt', 409, 'RECEIPT_REQUEST_CONFLICT')
      return { code: p.lines[0].giftCardCode!, amount: p.lines[0].amount, duplicate: true }
    }
    let attempt = 0
    for (;;) {
      const code = newGiftCode()
      try {
        const { runtime } = await reserveHold(tx, req, { id: reference, organizationId: req.user.organizationId, customerId: input.customerId ?? null }, [{ method: input.method, amount: input.amount, giftCardCode: code }], reference, 'issue', { expiresAt: input.expiresAt ?? null })
        const { takeReceipt } = await import('./customerReceipts')
        await takeReceipt(tx, req, { branchId: runtime.branchId, type: 'gift_card_sale', method: input.method as never, amount: input.amount, requestId: input.requestId, customerId: input.customerId ?? null, credit: 'GIFT_CARD_LIABILITY', description: `Gift card sold ${code}` })
        return { code, amount: input.amount, duplicate: false }
      } catch (error) {
        if ((error as AppError).code !== 'GIFT_CARD_CODE_TAKEN' || ++attempt > 4) throw error
      }
    }
  }, { timeout: 30000 })
}

// House-account payment at the branch: the cash and the receivable journal
// are local; the customer's central balance falls once this is confirmed.
export async function payHouseAccountAtBranch(req: Request, customerId: string, input: { requestId: string; method: string; amount: number }) {
  const reference = `house-payment:${input.requestId}`
  return prisma.$transaction(async tx => {
    await localWalletLock(tx)
    if (await tx.branchWalletReceipt.findFirst({ where: { reference } })) {
      const receipt = await tx.customerReceipt.findUniqueOrThrow({ where: { organizationId_requestId: { organizationId: req.user.organizationId, requestId: input.requestId } } })
      if (receipt.type !== 'house_account_payment' || receipt.method !== input.method || Math.abs(receipt.amount - input.amount) > regionalMoneyTolerance() || receipt.customerId !== customerId) throw new AppError('This request ID was already used for a different receipt', 409, 'RECEIPT_REQUEST_CONFLICT')
      return { receipt, duplicate: true }
    }
    const { runtime } = await reserveHold(tx, req, { id: reference, organizationId: req.user.organizationId, customerId }, [{ method: input.method, amount: input.amount }], reference, 'settle')
    const { takeReceipt } = await import('./customerReceipts')
    const { receipt } = await takeReceipt(tx, req, { branchId: runtime.branchId, type: 'house_account_payment', method: input.method as never, amount: input.amount, requestId: input.requestId, customerId, credit: 'ACCOUNTS_RECEIVABLE', description: 'House account payment' })
    return { receipt, duplicate: false }
  }, { timeout: 30000 })
}
export async function debitBranchWallet(tx: Tx, req: Request, order: { id: string; organizationId: string; customerId: string | null }, lines: TenderLine[], reference: string) {
  if (!lines.some(stored)) return
  const runtime = await localWalletLock(tx)
  const payload = await reservePayload(tx, reference, () => localPayload(tx, req, order, lines, reference, 'spend'))
  await tx.branchWalletReceipt.create({ data: { id: payload.id, organizationId: runtime.organizationId, branchId: runtime.branchId, orderId: order.id, reference, payload } })
}
export async function earnLocalWallet(tx: Tx, req: Request, order: { id: string; organizationId: string; customerId: string | null }, lines: TenderLine[]) {
  if (!order.customerId || !lines.length) return null
  const runtime = await localWalletLock(tx)
  if (await tx.branchWalletReceipt.count({ where: { orderId: order.id, reference: `earn:${order.id}` } })) return null
  const payload = await localPayload(tx, req, order, lines, `earn:${order.id}`, 'earn')
  await tx.branchWalletReceipt.create({ data: { id: payload.id, organizationId: runtime.organizationId, branchId: runtime.branchId, orderId: order.id, reference: payload.reference, payload } })
  return null
}
export async function refundLocalWallet(tx: Tx, orderId: string, reference?: string, req?: Request) {
  if (await tx.branchWalletReceipt.count({ where: { orderId, ...(reference && { reference }) } })) {
    await localWalletLock(tx)
    await tx.branchWalletReceipt.updateMany({ where: { orderId, ...(reference && { reference }) }, data: { refunded: true, acknowledged: false } })
    return
  }
  // No local receipt: the sale was paid (or earned points) in the cloud before
  // this PC took over. The cloud reverses its own original movements, once,
  // when this local refund is confirmed. Online only, like any shared spend.
  const original = reference ?? orderId
  const order = await tx.customerOrder.findUnique({ where: { id: orderId }, select: { organizationId: true, customerId: true, payments: true } })
  if (!order || !req) return
  const paidWithShared = Array.isArray(order.payments) && (order.payments as { method?: string }[]).some(p => stored({ method: String(p?.method), amount: 0 }))
  if (original.startsWith('earn:') ? !order.customerId : !paidWithShared) return
  if (await tx.branchWalletReceipt.count({ where: { reference: `legacy-refund:${original}` } })) return
  try {
    await reserveHold(tx, req, { id: orderId, organizationId: order.organizationId, customerId: order.customerId }, [], `legacy-refund:${original}`, 'legacy_refund')
  } catch (error) {
    // Points never earned in the cloud: there is nothing to reverse.
    if ((error as AppError).code === 'WALLET_NOTHING_TO_REFUND' && original.startsWith('earn:')) return
    throw error
  }
}

let flushing = false
export async function flushBranchWallets() {
  if (flushing || process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  flushing = true
  try {
    await prisma.$transaction(async tx => {
      const runtime = await localWalletLock(tx)
      const remote = await callWallet('pending') as unknown as { pending: { id: string; digest: string }[]; head: { revision: string; digest: string | null } }
      const acknowledged = remote.head.revision === runtime.lastReplicaRevision.toString() && remote.head.digest === runtime.lastReplicaDigest
      const lostAck = runtime.pendingReplicaRevision !== null && remote.head.revision === runtime.pendingReplicaRevision.toString() && remote.head.digest === runtime.pendingReplicaDigest
      if (!acknowledged && !lostAck) throw new AppError('Wallet recovery refused on a restored/stale branch database', 409, 'WALLET_RECOVERY_REQUIRED')
      // The same lock surrounds all local spend/earn/refund transactions, so
      // an absent receipt proves rollback, never an in-flight local commit.
      for (const hold of remote.pending) {
        const receipt = await tx.branchWalletReceipt.findUnique({ where: { id: hold.id } })
        await callWallet('resolve', { id: hold.id, digest: hold.digest, action: !receipt ? 'release' : receipt.refunded ? 'refund' : 'commit' })
        if (receipt) await tx.branchWalletReceipt.update({ where: { id: receipt.id }, data: { acknowledged: true } })
      }
      const receipts = await tx.branchWalletReceipt.findMany({ where: { acknowledged: false }, orderBy: { createdAt: 'asc' }, take: 50 })
      for (const receipt of receipts) {
        const payload = payloadSchema.parse(receipt.payload)
        if (payload.kind === 'earn') await callWallet('earn', { payload, refunded: receipt.refunded })
        else await callWallet('resolve', { id: receipt.id, digest: replicaDigest(payload), action: receipt.refunded ? 'refund' : 'commit' })
        await tx.branchWalletReceipt.update({ where: { id: receipt.id }, data: { acknowledged: true } })
      }
    }, { timeout: 60000 })
    return true
  } catch { return false } finally { flushing = false }
}

export async function walletView(token: string, input: unknown) {
  const body = z.object({ actorId: z.string().min(1), phone: z.string().min(7).max(40).optional(), giftCardCode: z.string().trim().min(4).max(40).optional() }).strict().parse(input)
  return prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    await actor(tx, node, body.actorId)
    const { loyaltyConfig, giftCardByCode } = await import('./tenders')
    const config = await loyaltyConfig(tx, node.organizationId)
    const customer = body.phone ? await tx.customer.findUnique({ where: { organizationId_phone: { organizationId: node.organizationId, phone: body.phone } }, select: { loyaltyPoints: true, houseAccountEnabled: true, houseBalance: true, creditLimit: true } }) : null
    const card = body.giftCardCode ? await giftCardByCode(tx, node.organizationId, body.giftCardCode) : null
    return { policy: 'online-only', loyalty: config, customer, card }
  })
}
