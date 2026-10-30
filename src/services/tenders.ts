import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma } from '@prisma/client'
import { Request } from 'express'
import { AppError } from '../middleware/error'

// Stored-value and credit tenders: gift cards, loyalty points and house
// accounts. Each is a payment line like cash or card, debited here under a row
// lock inside the checkout transaction, and credited back on refund. Every
// movement is an immutable transaction row with a unique reference key, so a
// retried checkout or refund can never move the balance twice.

type Tx = Prisma.TransactionClient
export const STORED_VALUE_METHODS = ['gift_card', 'loyalty', 'house_account'] as const
export interface TenderLine { method: string; amount: number; giftCardCode?: string | null }
const round2 = (n: number) => regionalRoundMoney(n)
const isStoredValue = (m: string) => (STORED_VALUE_METHODS as readonly string[]).includes(m)

// Loyalty is live only with both manual rates set in Settings and its
// liability account mapped; zero / missing values keep it off.
export async function loyaltyConfig(db: Tx, organizationId: string) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return { earnPerUnit: 0, pointValue: 0, mapped: false, active: false }
  const [settings, mapping] = await Promise.all([
    db.commerceSettings.findUnique({ where: { organizationId }, select: { loyaltyEarnPerUnit: true, loyaltyPointValue: true } }),
    db.accountingMapping.findUnique({ where: { organizationId_key: { organizationId, key: 'LOYALTY_LIABILITY' } }, include: { account: true } }),
  ])
  const earnPerUnit = settings?.loyaltyEarnPerUnit ?? 0, pointValue = settings?.loyaltyPointValue ?? 0
  const mapped = !!mapping && mapping.account.status === 'ACTIVE'
  return { earnPerUnit, pointValue, mapped, active: earnPerUnit > 0 && pointValue > 0 && mapped }
}

export async function giftCardByCode(db: Tx, organizationId: string, code: string) {
  return db.giftCard.findUnique({ where: { organizationId_code: { organizationId, code: code.trim().toUpperCase() } } })
}

// reference: the order (or `${orderId}:check:${checkId}`) the lines belong to
export async function debitTenders(tx: Tx, req: Request, order: { id: string; organizationId: string; customerId: string | null }, lines: TenderLine[], reference = order.id) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    await (await import('./branchWallets')).debitBranchWallet(tx, req, order, lines, reference)
    return
  }
  for (const [i, line] of lines.entries()) {
    if (!isStoredValue(line.method)) continue
    const key = `debit:${reference}:${i}`
    const amount = round2(line.amount)
    if (line.method === 'gift_card') {
      if (!line.giftCardCode) throw new AppError('Enter the gift card code', 400, 'GIFT_CARD_REQUIRED')
      const found = await giftCardByCode(tx, order.organizationId, line.giftCardCode)
      if (!found) throw new AppError('Gift card not found', 404, 'GIFT_CARD_NOT_FOUND')
      await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${found.id} FOR UPDATE`
      const card = await tx.giftCard.findUniqueOrThrow({ where: { id: found.id } })
      if (card.status !== 'active') throw new AppError('This gift card is not active', 409, 'GIFT_CARD_INACTIVE')
      if (card.expiresAt && card.expiresAt < new Date()) throw new AppError('This gift card has expired', 409, 'GIFT_CARD_EXPIRED')
      if (card.balance + 0.0001 < amount) throw new AppError(`The gift card balance is ${round2(card.balance)}`, 409, 'GIFT_CARD_BALANCE')
      const balanceAfter = round2(card.balance - amount)
      await tx.giftCard.update({ where: { id: card.id }, data: { balance: balanceAfter } })
      await tx.giftCardTransaction.create({ data: { organizationId: order.organizationId, giftCardId: card.id, type: 'redeem', amount: -amount, balanceAfter, orderId: order.id, referenceKey: key, userId: req.user.id } })
      continue
    }
    if (!order.customerId) throw new AppError('Attach the customer to the order first', 400, 'CUSTOMER_REQUIRED')
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${order.customerId} FOR UPDATE`
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: order.customerId } })
    if (line.method === 'loyalty') {
      const config = await loyaltyConfig(tx, order.organizationId)
      if (!config.active) throw new AppError('Loyalty is not active. Set its rates and liability account in Settings', 409, 'LOYALTY_INACTIVE')
      const points = round2(amount / config.pointValue)
      if (customer.loyaltyPoints + 0.0001 < points) throw new AppError(`The customer has ${round2(customer.loyaltyPoints)} points (${round2(customer.loyaltyPoints * config.pointValue)})`, 409, 'LOYALTY_BALANCE')
      const balanceAfter = round2(customer.loyaltyPoints - points)
      await tx.customer.update({ where: { id: customer.id }, data: { loyaltyPoints: balanceAfter } })
      await tx.loyaltyTransaction.create({ data: { organizationId: order.organizationId, customerId: customer.id, type: 'redeem', points: -points, value: -amount, balanceAfter, orderId: order.id, referenceKey: key, userId: req.user.id } })
    } else {
      if (!customer.houseAccountEnabled) throw new AppError('This customer has no house account', 409, 'HOUSE_ACCOUNT_DISABLED')
      if (customer.houseBalance + amount > customer.creditLimit + 0.0001) throw new AppError(`This would exceed the credit limit (${round2(customer.creditLimit - customer.houseBalance)} available)`, 409, 'CREDIT_LIMIT')
      const balanceAfter = round2(customer.houseBalance + amount)
      await tx.customer.update({ where: { id: customer.id }, data: { houseBalance: balanceAfter } })
      await tx.houseAccountTransaction.create({ data: { organizationId: order.organizationId, customerId: customer.id, type: 'charge', amount, balanceAfter, orderId: order.id, referenceKey: key, userId: req.user.id } })
    }
  }
}

// Refund: every debit made for this order (reference) goes back where it came
// from. Idempotent through the reversal reference keys.
export async function creditTenders(tx: Tx, req: Request, organizationId: string, orderId: string, reference = orderId) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    await (await import('./branchWallets')).refundLocalWallet(tx, orderId, reference, req)
    return
  }
  const prefix = `debit:${reference}:`
  const [cards, points, house] = await Promise.all([
    tx.giftCardTransaction.findMany({ where: { organizationId, referenceKey: { startsWith: prefix } } }),
    tx.loyaltyTransaction.findMany({ where: { organizationId, referenceKey: { startsWith: prefix } } }),
    tx.houseAccountTransaction.findMany({ where: { organizationId, referenceKey: { startsWith: prefix } } }),
  ])
  for (const t of cards) {
    const key = t.referenceKey.replace('debit:', 'credit:')
    if (await tx.giftCardTransaction.count({ where: { referenceKey: key } })) continue
    await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${t.giftCardId} FOR UPDATE`
    const card = await tx.giftCard.findUniqueOrThrow({ where: { id: t.giftCardId } })
    const balanceAfter = round2(card.balance - t.amount)
    await tx.giftCard.update({ where: { id: card.id }, data: { balance: balanceAfter } })
    await tx.giftCardTransaction.create({ data: { organizationId, giftCardId: card.id, type: 'refund', amount: -t.amount, balanceAfter, orderId, referenceKey: key, userId: req.user.id } })
  }
  for (const t of points) {
    const key = t.referenceKey.replace('debit:', 'credit:')
    if (await tx.loyaltyTransaction.count({ where: { referenceKey: key } })) continue
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${t.customerId} FOR UPDATE`
    const c = await tx.customer.findUniqueOrThrow({ where: { id: t.customerId } })
    const balanceAfter = round2(c.loyaltyPoints - t.points)
    await tx.customer.update({ where: { id: c.id }, data: { loyaltyPoints: balanceAfter } })
    await tx.loyaltyTransaction.create({ data: { organizationId, customerId: c.id, type: 'reverse_redeem', points: -t.points, value: -t.value, balanceAfter, orderId, referenceKey: key, userId: req.user.id } })
  }
  for (const t of house) {
    const key = t.referenceKey.replace('debit:', 'credit:')
    if (await tx.houseAccountTransaction.count({ where: { referenceKey: key } })) continue
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${t.customerId} FOR UPDATE`
    const c = await tx.customer.findUniqueOrThrow({ where: { id: t.customerId } })
    const balanceAfter = round2(c.houseBalance - t.amount)
    await tx.customer.update({ where: { id: c.id }, data: { houseBalance: balanceAfter } })
    await tx.houseAccountTransaction.create({ data: { organizationId, customerId: c.id, type: 'reverse_charge', amount: -t.amount, balanceAfter, orderId, referenceKey: key, userId: req.user.id } })
  }
}

// Points for a completed order: on what was paid with money (not with points),
// at the manual Settings rate. Once per order.
export async function earnLoyalty(tx: Tx, req: Request, order: { id: string; organizationId: string; customerId: string | null }, lines: TenderLine[]) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return (await import('./branchWallets')).earnLocalWallet(tx, req, order, lines)
  if (!order.customerId) return null
  const config = await loyaltyConfig(tx, order.organizationId)
  if (!config.active) return null
  const base = round2(lines.filter((l) => l.method !== 'loyalty').reduce((n, l) => n + l.amount, 0))
  const points = Math.floor(base * config.earnPerUnit * 100) / 100
  if (points <= 0) return null
  const key = `earn:${order.id}`
  if (await tx.loyaltyTransaction.count({ where: { referenceKey: key } })) return null
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${order.customerId} FOR UPDATE`
  const c = await tx.customer.findUniqueOrThrow({ where: { id: order.customerId } })
  const balanceAfter = round2(c.loyaltyPoints + points)
  await tx.customer.update({ where: { id: c.id }, data: { loyaltyPoints: balanceAfter } })
  return tx.loyaltyTransaction.create({ data: { organizationId: order.organizationId, customerId: c.id, type: 'earn', points, value: round2(points * config.pointValue), balanceAfter, orderId: order.id, referenceKey: key, userId: req.user.id } })
}

// A refunded order takes back the points it earned. The balance may go below
// zero if they were already spent; that is shown, never hidden.
export async function reverseLoyaltyEarn(tx: Tx, req: Request, organizationId: string, orderId: string) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') {
    await (await import('./branchWallets')).refundLocalWallet(tx, orderId, `earn:${orderId}`, req)
    return
  }
  const earned = await tx.loyaltyTransaction.findUnique({ where: { referenceKey: `earn:${orderId}` } })
  if (!earned || await tx.loyaltyTransaction.count({ where: { referenceKey: `reverse_earn:${orderId}` } })) return
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${earned.customerId} FOR UPDATE`
  const c = await tx.customer.findUniqueOrThrow({ where: { id: earned.customerId } })
  const balanceAfter = round2(c.loyaltyPoints - earned.points)
  await tx.customer.update({ where: { id: c.id }, data: { loyaltyPoints: balanceAfter } })
  await tx.loyaltyTransaction.create({ data: { organizationId, customerId: c.id, type: 'reverse_earn', points: -earned.points, value: -earned.value, balanceAfter, orderId, referenceKey: `reverse_earn:${orderId}`, userId: req.user.id } })
}
