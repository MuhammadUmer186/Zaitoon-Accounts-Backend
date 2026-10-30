import { runWithCurrency, moneyTolerance } from './money'
import { roundMoney as regionalRoundMoney } from './money'
import crypto from 'crypto'
import { Prisma, PrismaClient, MenuShift } from '@prisma/client'
import { AppError } from '../middleware/error'
import { promotionsForOrder } from '../services/promotions'

type Db = PrismaClient | Prisma.TransactionClient

export const DEFAULT_SHIFTS = [
  { name: 'Breakfast', startTime: '07:00', endTime: '11:30', sortOrder: 1 },
  { name: 'Lunch', startTime: '12:00', endTime: '16:30', sortOrder: 2 },
  { name: 'Dinner', startTime: '19:00', endTime: '23:59', sortOrder: 3 },
]

export const ORDER_STATUSES = ['open', 'completed', 'cancelled'] as const
// statuses staff can set; 'awaiting' (a table-QR dish not yet accepted) is
// left only through accept / reject
export const ITEM_STATUSES = ['pending', 'preparing', 'ready', 'served', 'cancelled'] as const
export const AWAITING = 'awaiting'
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

// Orgs that never opened the Menu module have no shift rows yet — create
// the three standard ones the first time anything asks for them.
export async function ensureShifts(db: Db, organizationId: string): Promise<MenuShift[]> {
  const existing = await db.menuShift.findMany({ where: { organizationId }, orderBy: { sortOrder: 'asc' } })
  if (existing.length > 0) return existing
  await db.menuShift.createMany({
    data: DEFAULT_SHIFTS.map((s) => ({ ...s, organizationId })),
    skipDuplicates: true,
  })
  return db.menuShift.findMany({ where: { organizationId }, orderBy: { sortOrder: 'asc' } })
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Minutes since local midnight in the org's timezone.
export function localMinutes(timezone: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: isValidTimezone(timezone) ? timezone : 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

export function isShiftRunning(shift: Pick<MenuShift, 'startTime' | 'endTime'>, minutes: number): boolean {
  const start = toMinutes(shift.startTime)
  const end = toMinutes(shift.endTime)
  if (start === end) return true // all-day
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end // runs past midnight
}

export function currentShift<T extends Pick<MenuShift, 'startTime' | 'endTime' | 'isActive'>>(
  shifts: T[],
  timezone: string,
  now = new Date()
): T | null {
  const minutes = localMinutes(timezone, now)
  return shifts.find((s) => s.isActive && isShiftRunning(s, minutes)) ?? null
}

// The next active shift to start after now (wrapping to tomorrow).
export function nextShift<T extends Pick<MenuShift, 'startTime' | 'isActive'>>(
  shifts: T[],
  timezone: string,
  now = new Date()
): T | null {
  const minutes = localMinutes(timezone, now)
  const active = shifts.filter((s) => s.isActive)
  if (active.length === 0) return null
  const wait = (s: T) => (toMinutes(s.startTime) - minutes + 1440) % 1440
  return [...active].sort((a, b) => wait(a) - wait(b))[0]
}

export function newTableToken(): string {
  return crypto.randomBytes(12).toString('base64url')
}

const round2 = (n: number) => regionalRoundMoney(n)

// Menu prices are VAT-inclusive, so the VAT is carved out of the (discounted)
// total rather than added on top.
// enforceMinimum: at intake (order created or dishes added) only. A void, a
// rejected dish or checkout on an accepted order is never blocked by it.
export async function recalcOrderTotals(db: Db, orderId: string, opts: { enforceMinimum?: boolean } = {}) {
  const order = await db.customerOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { organization: { select: { currency: true } }, items: { include: { dish: { select: { categoryId: true } } } }, branch: { select: { vatEnabled: true, vatRate: true } } },
  })
  return runWithCurrency(order.organization.currency, async () => {
  const active = order.items.filter((i) => i.status !== 'cancelled')
  const itemsTotal = round2(active.reduce((sum, i) => sum + i.lineTotal, 0))
  // a discount can never exceed what is on the order
  const discountAmount = round2(Math.min(order.discountAmount, itemsTotal))
  // promotions are priced while the order is open; a paid / closed order keeps
  // what it was charged, and an offline sale keeps the price the device charged
  let promotionAmount = round2(Math.min(order.promotionAmount, itemsTotal - discountAmount)), promotions = order.promotions
  if (['pending', 'open'].includes(order.status) && !order.offlineOrderNo) {
    const promo = await promotionsForOrder(db as Prisma.TransactionClient, order, active.map((i) => ({ dishId: i.dishId, categoryId: i.dish?.categoryId ?? null, unitPrice: i.unitPrice, quantity: i.quantity })))
    promotionAmount = round2(Math.min(promo.amount, itemsTotal - discountAmount))
    promotions = promo.applied.length ? promo.applied as unknown as Prisma.JsonValue : null
  }
  const merchandise = round2(itemsTotal - discountAmount - promotionAmount)
  if (opts.enforceMinimum && order.orderType === 'delivery' && order.deliveryZoneId && ['pending', 'open'].includes(order.status) && itemsTotal - discountAmount + moneyTolerance() < order.deliveryMinimumOrder) throw new AppError(`Food total must be at least ${order.deliveryMinimumOrder} for this delivery zone (delivery fee excluded)`, 400, 'DELIVERY_MINIMUM')
  const fee = order.orderType === 'delivery' ? order.deliveryFee : 0
  const feeVat = round2(fee * order.deliveryFeeVatRate / (100 + order.deliveryFeeVatRate))
  const total = round2(merchandise + fee)
  const vatRate = order.branch.vatEnabled ? order.branch.vatRate : 0
  const vatAmount = round2((vatRate > 0 ? (merchandise * vatRate) / (100 + vatRate) : 0) + feeVat)
  return db.customerOrder.update({
    where: { id: orderId },
    data: { itemsTotal, discountAmount, promotionAmount, promotions: promotions ?? Prisma.DbNull, totalAmount: total, vatRate, vatAmount, deliveryFeeVatAmount: feeVat, subtotal: round2(total - vatAmount) },
  })
  })
}

// Sequential, human-friendly order numbers per organization (guests type
// this number into the review form). Callers retry on a unique-constraint
// clash when two orders race for the same number.
// Numbers are per branch: each branch has exactly one writer (the cloud or its
// enrolled PC), so a branch PC and the cloud can never issue the same number.
export async function nextOrderNo(db: Db, organizationId: string, branchId: string): Promise<number> {
  const last = await db.customerOrder.findFirst({
    where: { organizationId, branchId },
    orderBy: { orderNo: 'desc' },
    select: { orderNo: true },
  })
  return (last?.orderNo ?? 1000) + 1
}
