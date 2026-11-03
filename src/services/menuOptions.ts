import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/error'
import type { RecipeLine } from './foodCost'
import { branchUnavailable, optionPrices } from './branchMenu'

type Db = PrismaClient | Prisma.TransactionClient

// Sizes, modifiers and combos (Foodics-style menu model), shared by the POS,
// the table QR menu and the online menu so a dish is priced and validated the
// same way everywhere. Prices are VAT-inclusive.

export const lineSelectionSchema = {
  sizeId: z.string().min(1).optional().nullable(),
  modifiers: z.array(z.string().min(1)).max(40).optional(), // modifier option ids
  combo: z.array(z.object({ groupId: z.string().min(1), optionId: z.string().min(1) })).max(20).optional(),
}
export interface LineSelectionInput { sizeId?: string | null; modifiers?: string[]; combo?: { groupId: string; optionId: string }[] }

// What is stored on the order line
export interface Selection {
  size?: { id: string; name: string; factor: number }
  modifiers?: { groupId: string; group: string; optionId: string; name: string; price: number; free: boolean; itemId?: string | null; itemQuantity?: number }[]
  combo?: { groupId: string; group: string; optionId: string; dishId: string; name: string; sizeId?: string | null; sizeName?: string | null; factor: number; priceDelta: number }[]
}

export interface DishOptions {
  sizes: { id: string; name: string; price: number; factor: number; isDefault: boolean }[]
  groups: { id: string; name: string; min: number; max: number; free: number; options: { id: string; name: string; price: number; isDefault: boolean; itemId: string | null; itemQuantity: number }[] }[]
  combo: { id: string; name: string; min: number; max: number; options: { id: string; dishId: string; name: string; sizeId: string | null; sizeName: string | null; factor: number; priceDelta: number; isDefault: boolean }[] }[]
  isCombo: boolean
}

// Effective options of dishes, as the POS / guest menus show them
export async function loadDishOptions(db: Db, dishIds: string[], branchId?: string): Promise<Map<string, DishOptions>> {
  const ids = [...new Set(dishIds)]
  const out = new Map<string, DishOptions>()
  if (ids.length === 0) return out
  const dishes = await db.dish.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, isCombo: true,
      sizes: { orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] },
      modifierLinks: { orderBy: { sortOrder: 'asc' }, include: { group: { include: { options: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } } } } },
      comboGroups: { orderBy: { sortOrder: 'asc' }, include: { options: { orderBy: { sortOrder: 'asc' }, include: { dish: { select: { name: true, isActive: true, sizes: true } } } } } },
    },
  })
  const branchRows = branchId ? await db.branchMenuItem.findMany({ where: { branchId, dishId: { in: ids } } }) : []
  const prices = new Map(branchRows.map(r => [r.dishId, optionPrices(r.optionPrices)]))
  for (const d of dishes) {
    const p = prices.get(d.id)
    out.set(d.id, {
      isCombo: d.isCombo,
      sizes: d.sizes.filter(s => !branchId || p?.sizes[s.id] !== undefined).map((s) => ({ id: s.id, name: s.name, price: p?.sizes[s.id] ?? s.price, factor: s.recipeFactor, isDefault: s.isDefault })),
      groups: d.modifierLinks.filter((l) => l.group.isActive).map((l) => {
        const options = l.group.options.filter((o) => !l.excludedOptionIds.includes(o.id) && (!branchId || p?.modifiers[o.id] !== undefined))
        const max = Math.max(1, Math.min(l.maxSelect ?? l.group.maxSelect, options.length || 1))
        return {
          id: l.group.id, name: l.group.name, min: Math.min(l.minSelect ?? l.group.minSelect, max), max, free: l.freeCount,
          options: options.map((o) => ({ id: o.id, name: o.name, price: p?.modifiers[o.id] ?? o.price, isDefault: o.isDefault, itemId: o.itemId, itemQuantity: o.itemQuantity })),
        }
      }),
      combo: d.comboGroups.map((g) => ({
        id: g.id, name: g.name, min: g.minSelect, max: Math.max(1, g.maxSelect),
        options: g.options.filter((o) => o.dish.isActive && (!branchId || p?.combo[o.id] !== undefined)).map((o) => {
          const size = o.sizeId ? o.dish.sizes.find((s) => s.id === o.sizeId) : undefined
          return { id: o.id, dishId: o.dishId, name: o.dish.name, sizeId: size?.id ?? null, sizeName: size?.name ?? null, factor: size?.recipeFactor ?? 1, priceDelta: p?.combo[o.id] ?? o.priceDelta, isDefault: o.isDefault }
        }),
      })),
    })
  }
  return out
}

// `options` for a dish in a menu payload (POS and guest menus): absent for a
// plain dish; combo components out of stock at the branch are flagged
export function menuOptionsPayload(o: DishOptions | undefined, off: Set<string>) {
  if (!o || (!o.sizes.length && !o.groups.length && !o.isCombo)) return {}
  return {
    options: {
      ...o,
      groups: o.groups.map((g) => ({ ...g, options: g.options.map(({ itemId: _i, itemQuantity: _q, ...rest }) => rest) })),
      combo: o.combo.map((g) => ({ ...g, options: g.options.map((x) => ({ ...x, available: !off.has(x.dishId) })) })),
    },
  }
}

const r2 = (n: number) => regionalRoundMoney(n)

// Validates a selection against the dish's options and prices it.
// `unavailable` = dish ids out of stock at the branch (combo components).
export function priceSelection(dish: { id: string; name: string; price: number }, opts: DishOptions | undefined, input: LineSelectionInput, unavailable: Set<string> = new Set()): { unitPrice: number; selection: Selection | null } {
  const fail = (msg: string) => { throw new AppError(`${dish.name}: ${msg}`, 400, 'INVALID_SELECTION') }
  if (!opts) return { unitPrice: dish.price, selection: null }
  const selection: Selection = {}
  let price = dish.price

  // size
  if (opts.sizes.length) {
    const size = input.sizeId ? opts.sizes.find((s) => s.id === input.sizeId) : opts.sizes.find((s) => s.isDefault) ?? (opts.sizes.length === 1 ? opts.sizes[0] : undefined)
    if (!size) fail(input.sizeId ? 'that size is not offered' : 'choose a size')
    selection.size = { id: size!.id, name: size!.name, factor: size!.factor }
    price = size!.price
  } else if (input.sizeId) fail('this dish has no sizes')

  // modifiers
  const chosen = input.modifiers ?? []
  if (new Set(chosen).size !== chosen.length) fail('an option was chosen twice')
  const known = new Map(opts.groups.flatMap((g) => g.options.map((o) => [o.id, g] as const)))
  for (const id of chosen) if (!known.has(id)) fail('an option is not offered on this dish')
  const mods: NonNullable<Selection['modifiers']> = []
  for (const g of opts.groups) {
    const picked = g.options.filter((o) => chosen.includes(o.id))
    if (picked.length < g.min) fail(`choose ${g.min === g.max ? g.min : `at least ${g.min}`} in "${g.name}"`)
    if (picked.length > g.max) fail(`choose at most ${g.max} in "${g.name}"`)
    // the first `free` choices (most expensive first) cost nothing
    const byPrice = [...picked].sort((a, b) => b.price - a.price)
    byPrice.forEach((o, i) => {
      const free = i < g.free
      if (!free) price += o.price
      mods.push({ groupId: g.id, group: g.name, optionId: o.id, name: o.name, price: free ? 0 : o.price, free, itemId: o.itemId, itemQuantity: o.itemQuantity })
    })
  }
  if (mods.length) selection.modifiers = mods

  // combo
  if (opts.isCombo) {
    const choices = input.combo ?? []
    if (new Set(choices.map((c) => `${c.groupId}:${c.optionId}`)).size !== choices.length) fail('a combo option was chosen twice')
    const combo: NonNullable<Selection['combo']> = []
    for (const g of opts.combo) {
      const picked = choices.filter((c) => c.groupId === g.id)
      const resolved = picked.map((c) => g.options.find((o) => o.id === c.optionId) ?? fail(`that choice is not offered in "${g.name}"`)!)
      if (resolved.length < g.min) fail(`choose ${g.min === 1 ? 'one' : g.min} in "${g.name}"`)
      if (resolved.length > g.max) fail(`choose at most ${g.max} in "${g.name}"`)
      for (const o of resolved) {
        if (unavailable.has(o.dishId)) fail(`${o.name} is out of stock`)
        price += o.priceDelta
        combo.push({ groupId: g.id, group: g.name, optionId: o.id, dishId: o.dishId, name: o.name, sizeId: o.sizeId, sizeName: o.sizeName, factor: o.factor, priceDelta: o.priceDelta })
      }
    }
    for (const c of choices) if (!opts.combo.some((g) => g.id === c.groupId)) fail('a combo choice does not belong to this combo')
    if (combo.length) selection.combo = combo
  } else if (input.combo?.length) fail('this dish is not a combo')

  if (price < 0) fail('the selected upgrades would make the price negative')
  return { unitPrice: r2(price), selection: Object.keys(selection).length ? selection : null }
}

// Human-readable lines under the dish name (kitchen slip, receipt, screens)
export function selectionLines(sel: Selection | null | undefined): string[] {
  if (!sel) return []
  return [
    ...(sel.size ? [sel.size.name] : []),
    ...(sel.combo ?? []).map((c) => `${c.group}: ${c.name}${c.sizeName ? ` (${c.sizeName})` : ''}`),
    ...(sel.modifiers ?? []).map((m) => `+ ${m.name}`),
  ]
}

// The recipe one unit of an order line draws: the dish (scaled by size), the
// combo components (scaled by their size) and stock-linked modifiers
export function lineRecipe(dishIngredients: RecipeLine[], sel: Selection | null | undefined, ingredientsByDish: Map<string, RecipeLine[]>): RecipeLine[] {
  const factor = sel?.size?.factor ?? 1
  const lines: RecipeLine[] = dishIngredients.map((g) => ({ ...g, quantity: g.quantity * factor }))
  for (const c of sel?.combo ?? []) for (const g of ingredientsByDish.get(c.dishId) ?? []) lines.push({ ...g, quantity: g.quantity * c.factor })
  for (const m of sel?.modifiers ?? []) if (m.itemId && m.itemQuantity) lines.push({ itemId: m.itemId, quantity: m.itemQuantity, wastePct: 0 })
  return lines
}

// Kitchen station of each dish: the dish's own, else its category's (only
// active stations of the organization count)
export async function resolveStations(db: Db, organizationId: string, dishIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(dishIds)]
  if (ids.length === 0) return new Map()
  const [dishes, stations] = await Promise.all([
    db.dish.findMany({ where: { id: { in: ids } }, select: { id: true, stationId: true, category: { select: { stationId: true } } } }),
    db.kitchenStation.findMany({ where: { organizationId, isActive: true }, select: { id: true } }),
  ])
  const active = new Set(stations.map((s) => s.id))
  return new Map(dishes.map((d) => {
    const id = d.stationId ?? d.category.stationId
    return [d.id, id && active.has(id) ? id : null]
  }))
}

// Prices a set of POS / guest order lines for a branch
export async function priceLines(
  db: Db,
  input: { organizationId: string; branchId: string; items: ({ dishId: string; quantity: number; notes?: string | null } & LineSelectionInput)[] },
) {
  const dishIds = [...new Set(input.items.map((i) => i.dishId))]
  const { menu, off } = await branchUnavailable(db, input.organizationId, input.branchId)
  const opts = await loadDishOptions(db, dishIds, input.branchId)
  const componentIds = [...opts.values()].flatMap((o) => o.combo.flatMap((g) => g.options.map((x) => x.dishId)))
  const allIds = [...new Set([...dishIds, ...componentIds])]
  const [dishes, outOfStock] = await Promise.all([
    db.dish.findMany({ where: { id: { in: dishIds }, organizationId: input.organizationId }, include: { category: { select: { isActive: true } } } }),
    db.dishOutOfStock.findMany({ where: { branchId: input.branchId, dishId: { in: allIds } }, select: { dishId: true } }),
  ])
  const byId = new Map(dishes.map((d) => [d.id, d]))
  for (const o of outOfStock) off.add(o.dishId)
  const stations = await resolveStations(db, input.organizationId, dishIds)
  const unavailable = dishIds.filter((id) => { const d = byId.get(id); return !d || !menu.get(id)?.isActive || !d.isActive || !d.category.isActive || off.has(id) })
  if (unavailable.length) return { unavailable, lines: [] as never[] }
  const lines = input.items.map((i) => {
    const d = byId.get(i.dishId)!
    const { unitPrice, selection } = priceSelection({ ...d, price: menu.get(d.id)!.price }, opts.get(d.id), i, off)
    return { dishId: d.id, dishName: d.name, unitPrice, quantity: i.quantity, lineTotal: r2(unitPrice * i.quantity), notes: i.notes || null, selection: (selection ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull, stationId: stations.get(d.id) ?? null }
  })
  return { unavailable: [] as string[], lines }
}
