import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma, PrismaClient } from '@prisma/client'
import { lineRecipe, Selection } from './menuOptions'

type Db = PrismaClient | Prisma.TransactionClient

// Recipe-based food cost.
//
// A dish's recipe lists inventory items with the quantity used in ONE portion
// (in the item's own unit) plus a waste % for trimming / cooking loss:
//     portion cost = Σ quantity × (1 + waste%) × ingredient unit cost
//
// Ingredient unit cost = the branch's weighted-average stock cost; if that
// branch has never held the item, the average across all branches; failing
// that, the item's catalog cost price.
//
// Every paid order stores each dish's portion cost (so reports keep the cost
// at the time of sale). In "recipes" mode the ingredients are also taken out
// of stock at that moment.

const round2 = (n: number) => regionalRoundMoney(n)
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000

export async function ingredientCosts(db: Db, organizationId: string, itemIds: string[], branchId?: string | null) {
  const ids = [...new Set(itemIds)]
  const costs = new Map<string, number>()
  if (ids.length === 0) return costs
  const [items, stocks] = await Promise.all([
    db.item.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, costPrice: true } }),
    db.branchStock.findMany({ where: { itemId: { in: ids }, organizationId }, select: { branchId: true, itemId: true, quantityOnHand: true, averageCost: true, totalValue: true } }),
  ])
  for (const item of items) {
    const rows = stocks.filter((s) => s.itemId === item.id)
    const own = branchId ? rows.find((s) => s.branchId === branchId && s.averageCost > 0) : undefined
    let cost = own?.averageCost ?? 0
    if (!cost) {
      const positive = rows.filter((s) => s.quantityOnHand > 0 && s.totalValue > 0)
      const qty = positive.reduce((n, s) => n + s.quantityOnHand, 0)
      cost = qty > 0 ? positive.reduce((n, s) => n + s.totalValue, 0) / qty : rows.find((s) => s.averageCost > 0)?.averageCost ?? 0
    }
    costs.set(item.id, cost || item.costPrice || 0)
  }
  return costs
}

export interface RecipeLine { itemId: string; quantity: number; wastePct: number }

// Quantity of an item actually drawn from stock for one portion
export const grossQuantity = (l: RecipeLine) => l.quantity * (1 + (l.wastePct || 0) / 100)

export const portionCost = (lines: RecipeLine[], costs: Map<string, number>) =>
  round4(lines.reduce((n, l) => n + grossQuantity(l) * (costs.get(l.itemId) ?? 0), 0))

// Costing for the Menu → Recipes & cost screen
export async function dishCosting(db: Db, organizationId: string, branchId?: string | null) {
  const dishes = await db.dish.findMany({
    where: { organizationId },
    include: {
      category: { select: { id: true, name: true, sortOrder: true } },
      ingredients: { include: { item: { select: { id: true, name: true, unit: true, isActive: true } } }, orderBy: { sortOrder: 'asc' } },
    },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
  })
  const costs = await ingredientCosts(db, organizationId, dishes.flatMap((d) => d.ingredients.map((i) => i.itemId)), branchId)
  return { dishes, costs }
}

// Sets unit costs on a just-paid order and, in "recipes" mode, takes its
// ingredients out of the branch's stock. Runs once per order.
export async function costAndConsumeOrder(tx: Prisma.TransactionClient, orderId: string, userId: string) {
  const order = await tx.customerOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      organization: { select: { foodCostMethod: true } },
      items: { where: { status: { not: 'cancelled' } }, include: { dish: { include: { ingredients: true } } } },
    },
  })
  // recipe per line: dish × size, combo components, stock-linked modifiers
  const components = await componentIngredients(tx, order.items.map((i) => i.selection as Selection | null))
  const recipes = order.items.map((i) => lineRecipe(i.dish.ingredients, i.selection as Selection | null, components))
  const costs = await ingredientCosts(tx, order.organizationId, recipes.flat().map((g) => g.itemId), order.branchId)

  let foodCost = 0
  const usage = new Map<string, number>() // itemId → quantity drawn from stock
  for (const [n, line] of order.items.entries()) {
    const unitCost = portionCost(recipes[n], costs)
    foodCost += unitCost * line.quantity
    await tx.customerOrderItem.update({ where: { id: line.id }, data: { unitCost } })
    for (const g of recipes[n]) usage.set(g.itemId, (usage.get(g.itemId) ?? 0) + grossQuantity(g) * line.quantity)
  }

  const deduct = order.organization.foodCostMethod === 'recipes' && !order.stockDeductedAt && usage.size > 0
  if (deduct) {
    for (const [itemId, qty] of usage) {
      await moveStock(tx, {
        organizationId: order.organizationId, branchId: order.branchId, itemId, quantity: -round4(qty),
        fallbackCost: costs.get(itemId) ?? 0, movementType: 'sale', orderId: order.id, createdBy: userId,
        notes: `Sold — order #${order.orderNo}`,
      })
    }
  }
  return tx.customerOrder.update({
    where: { id: order.id },
    data: { foodCost: round2(foodCost), ...(deduct && { stockDeductedAt: new Date() }) },
  })
}

// A dish cancelled after the kitchen started on it: record what the portion
// cost and, in "recipes" mode, take its ingredients out of stock as wastage
// (a refund never puts these back).
export async function writeOffCancelledItem(tx: Prisma.TransactionClient, itemId: string, userId: string) {
  const line = await tx.customerOrderItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { order: { include: { organization: { select: { foodCostMethod: true } } } }, dish: { include: { ingredients: true } } },
  })
  const { order } = line
  const recipe = lineRecipe(line.dish.ingredients, line.selection as Selection | null, await componentIngredients(tx, [line.selection as Selection | null]))
  const costs = await ingredientCosts(tx, order.organizationId, recipe.map((g) => g.itemId), order.branchId)
  await tx.customerOrderItem.update({ where: { id: line.id }, data: { unitCost: portionCost(recipe, costs) } })
  if (order.organization.foodCostMethod !== 'recipes') return
  for (const g of recipe) {
    await moveStock(tx, {
      organizationId: order.organizationId, branchId: order.branchId, itemId: g.itemId, quantity: -round4(grossQuantity(g) * line.quantity),
      fallbackCost: costs.get(g.itemId) ?? 0, movementType: 'wastage', orderId: order.id, createdBy: userId,
      notes: `Cancelled after cooking — ${line.quantity}× ${line.dishName}, order #${order.orderNo}`,
    })
  }
}

// Recipes of the combo components chosen on some order lines
async function componentIngredients(tx: Prisma.TransactionClient, selections: (Selection | null)[]): Promise<Map<string, RecipeLine[]>> {
  const ids = [...new Set(selections.flatMap((s) => (s?.combo ?? []).map((c) => c.dishId)))]
  if (ids.length === 0) return new Map()
  const rows = await tx.dishIngredient.findMany({ where: { dishId: { in: ids } }, select: { dishId: true, itemId: true, quantity: true, wastePct: true } })
  const map = new Map<string, RecipeLine[]>()
  for (const r of rows) map.set(r.dishId, [...(map.get(r.dishId) ?? []), { itemId: r.itemId, quantity: r.quantity, wastePct: r.wastePct }])
  return map
}

// Refund: put back what the order took out of stock, at the same cost
export async function restoreOrderStock(tx: Prisma.TransactionClient, orderId: string, userId: string) {
  const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId } })
  if (!order.stockDeductedAt) return
  const moves = await tx.stockMovement.findMany({ where: { referenceType: 'customer_order', referenceId: orderId, movementType: 'sale' } })
  for (const m of moves) {
    await moveStock(tx, {
      organizationId: m.organizationId, branchId: m.branchId, itemId: m.itemId, quantity: -m.quantity,
      fallbackCost: m.unitCost, unitCost: m.unitCost, movementType: 'sale_return', orderId, createdBy: userId,
      notes: `Refund — order #${order.orderNo}`,
    })
  }
  await tx.customerOrder.update({ where: { id: orderId }, data: { stockDeductedAt: null } })
}

// Signed stock movement at weighted-average cost. Sales may take stock below
// zero (a sale is never refused for a counting gap); the negative balance
// keeps its average cost so the next purchase re-averages correctly.
async function moveStock(tx: Prisma.TransactionClient, m: {
  organizationId: string; branchId: string; itemId: string; quantity: number; fallbackCost: number
  unitCost?: number; movementType: string; orderId: string; createdBy: string; notes: string
}) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${m.branchId}`}))`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock:${m.branchId}:${m.itemId}`}))`
  const stock = await tx.branchStock.findUnique({ where: { branchId_itemId: { branchId: m.branchId, itemId: m.itemId } } })
  const unitCost = m.unitCost ?? (stock && stock.averageCost > 0 ? stock.averageCost : m.fallbackCost)
  await tx.stockMovement.create({
    data: {
      organizationId: m.organizationId, branchId: m.branchId, itemId: m.itemId, movementType: m.movementType,
      quantity: m.quantity, unitCost, totalValue: round2(Math.abs(m.quantity) * unitCost),
      referenceType: 'customer_order', referenceId: m.orderId, notes: m.notes, createdBy: m.createdBy,
    },
  })
  if (stock) {
    const qty = round4(stock.quantityOnHand + m.quantity)
    const value = stock.totalValue + m.quantity * unitCost
    const avg = qty > 0 && value > 0 ? value / qty : stock.averageCost || unitCost
    await tx.branchStock.update({
      where: { id: stock.id },
      data: { quantityOnHand: qty, totalValue: round2(qty > 0 ? value : qty * avg), averageCost: avg, lastUpdated: new Date() },
    })
  } else {
    const item = await tx.item.findUnique({ where: { id: m.itemId }, select: { reorderPoint: true } })
    await tx.branchStock.create({
      data: {
        organizationId: m.organizationId, branchId: m.branchId, itemId: m.itemId, quantityOnHand: m.quantity,
        averageCost: unitCost, totalValue: round2(m.quantity * unitCost), reorderPoint: item?.reorderPoint ?? 0,
      },
    })
  }
}
