import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma, Promotion } from '@prisma/client'

// Promotions are priced on the server only. They are evaluated against the
// moment the order was placed (a happy-hour order keeps its price when paid
// later) and never exceed the food total. Stackable promotions add up;
// otherwise the single best one applies.

type Db = Prisma.TransactionClient
const round2 = (n: number) => regionalRoundMoney(n)
export interface PromoLine { dishId: string; categoryId: string | null; unitPrice: number; quantity: number }
export interface AppliedPromotion { id: string; name: string; type: string; amount: number; couponCode?: string | null }

function localParts(at: Date, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]))
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute) }
}
const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

// does the promotion apply to this order at all (where, when, who, coupon)?
export function promotionApplies(p: Promotion, ctx: { branchId: string; at: Date; timeZone: string; customerTags: string[]; couponCode: string | null }) {
  if (!p.isActive) return false
  if (p.branchIds.length && !p.branchIds.includes(ctx.branchId)) return false
  if (p.startsAt && ctx.at < p.startsAt) return false
  if (p.endsAt && ctx.at > p.endsAt) return false
  const { day, minutes } = localParts(ctx.at, ctx.timeZone)
  if (p.daysOfWeek.length && !p.daysOfWeek.includes(day)) return false
  if (p.startTime && p.endTime) {
    const from = toMinutes(p.startTime), to = toMinutes(p.endTime)
    // a window may cross midnight (e.g. 22:00–02:00)
    if (from <= to ? minutes < from || minutes >= to : minutes < from && minutes >= to) return false
  }
  if (p.customerTags.length && !p.customerTags.some((t) => ctx.customerTags.includes(t))) return false
  if (p.couponCode && p.couponCode.toUpperCase() !== (ctx.couponCode ?? '').toUpperCase()) return false
  return true
}

// what the promotion takes off these lines (VAT-inclusive money)
export function promotionDiscount(p: Promotion, lines: PromoLine[]) {
  const eligible = lines.filter((l) => p.scope === 'all' || (p.scope === 'dishes' ? p.dishIds.includes(l.dishId) : !!l.categoryId && p.categoryIds.includes(l.categoryId)))
  const eligibleTotal = round2(eligible.reduce((n, l) => n + l.unitPrice * l.quantity, 0))
  const orderTotal = round2(lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0))
  if (p.minimumSpend && (p.type === 'free_item_over' ? orderTotal : eligibleTotal) + 0.0001 < p.minimumSpend) return 0
  switch (p.type) {
    case 'percent': return round2(eligibleTotal * Math.min(p.value, 100) / 100)
    case 'fixed': return round2(Math.min(p.value, eligibleTotal))
    case 'price_override': return round2(eligible.reduce((n, l) => n + Math.max(0, l.unitPrice - p.value) * l.quantity, 0))
    case 'buy_x_get_y': {
      const buy = p.buyQuantity ?? 0, get = p.getQuantity ?? 0
      if (buy < 1 || get < 1) return 0
      // every unit, dearest first; in each group of buy+get the cheapest `get` are free
      const units = eligible.flatMap((l) => Array(l.quantity).fill(l.unitPrice) as number[]).sort((a, b) => b - a)
      let free = 0
      for (let i = 0; i + buy + get <= units.length; i += buy + get) free += units.slice(i + buy, i + buy + get).reduce((n, u) => n + u, 0)
      return round2(free)
    }
    case 'free_item_over': {
      const target = lines.filter((l) => l.dishId === p.freeDishId)
      return target.length ? round2(Math.min(...target.map((l) => l.unitPrice))) : 0
    }
    default: return 0
  }
}

// The promotions for an open order: best single, or the stackable ones together
export async function promotionsForOrder(db: Db, order: { organizationId: string; branchId: string; createdAt: Date; couponCode: string | null; customerId: string | null }, lines: PromoLine[]) {
  if (!lines.length) return { amount: 0, applied: [] as AppliedPromotion[] }
  const [promos, org, customer] = await Promise.all([
    db.promotion.findMany({ where: { organizationId: order.organizationId, isActive: true }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] }),
    db.organization.findUniqueOrThrow({ where: { id: order.organizationId }, select: { timezone: true } }),
    order.customerId ? db.customer.findUnique({ where: { id: order.customerId }, select: { tags: true } }) : null,
  ])
  if (!promos.length) return { amount: 0, applied: [] as AppliedPromotion[] }
  const ctx = { branchId: order.branchId, at: order.createdAt, timeZone: org.timezone, customerTags: customer?.tags ?? [], couponCode: order.couponCode }
  const candidates = promos.filter((p) => promotionApplies(p, ctx)).map((p) => ({ p, amount: promotionDiscount(p, lines) })).filter((c) => c.amount > 0)
  if (!candidates.length) return { amount: 0, applied: [] as AppliedPromotion[] }
  const food = round2(lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0))
  const stacked = candidates.filter((c) => c.p.stackable)
  const stackedTotal = stacked.reduce((n, c) => n + c.amount, 0)
  const best = candidates.reduce((a, b) => (b.amount > a.amount ? b : a))
  const chosen = stacked.length > 1 && stackedTotal > best.amount ? stacked : [best]
  // never more than the food on the bill: trim the last applied promotion
  let left = food
  const applied = chosen.map((c) => { const amount = round2(Math.min(c.amount, left)); left = round2(left - amount); return { id: c.p.id, name: c.p.name, type: c.p.type, amount, couponCode: c.p.couponCode } }).filter((a) => a.amount > 0)
  return { amount: round2(applied.reduce((n, a) => n + a.amount, 0)), applied }
}

// Settings → "Allow promotions to combine with manual discounts". Off: a bill
// that has a promotion cannot also get a staff discount.
export async function assertPromotionCombination(db: Db, organizationId: string, manualDiscount: number, promotionAmount: number) {
  if (manualDiscount <= 0 || promotionAmount <= 0) return
  const settings = await db.commerceSettings.findUnique({ where: { organizationId }, select: { promotionsStack: true } })
  if (!settings?.promotionsStack) {
    const { AppError } = await import('../middleware/error')
    throw new AppError('This bill already has a promotion. Settings do not allow a manual discount on top of it', 409, 'PROMOTION_DISCOUNT_CONFLICT')
  }
}
