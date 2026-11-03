import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'

type Db = PrismaClient | Prisma.TransactionClient
export interface OptionPrices { sizes: Record<string, number>; modifiers: Record<string, number>; combo: Record<string, number> }
export const optionPrices = (value: Prisma.JsonValue): OptionPrices => value as unknown as OptionPrices

export async function catalogPrices(db: Db, organizationId: string, dishId: string): Promise<OptionPrices> {
  const dish = await db.dish.findFirst({ where: { id: dishId, organizationId }, include: {
    sizes: true, modifierLinks: { include: { group: { include: { options: true } } } },
    comboGroups: { include: { options: true } },
  } })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  return {
    sizes: Object.fromEntries(dish.sizes.map(s => [s.id, s.price])),
    modifiers: Object.fromEntries(dish.modifierLinks.flatMap(l => l.group.options.map(o => [o.id, o.price]))),
    combo: Object.fromEntries(dish.comboGroups.flatMap(g => g.options.map(o => [o.id, o.priceDelta]))),
  }
}

// Snapshot once. A missing row after initialization means the dish is not on
// this branch's menu; later catalog edits never silently change branch prices.
export async function ensureBranchMenu(db: Db, organizationId: string, branchId: string): Promise<void> {
  const branch = await db.branch.findFirst({ where: { id: branchId, organizationId }, select: { menuInitialized: true } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (branch.menuInitialized) return
  if ('$transaction' in db) return db.$transaction(tx => ensureBranchMenu(tx, organizationId, branchId), { timeout: 120000 })
  await db.$queryRaw`SELECT id FROM "Branch" WHERE id = ${branchId} FOR UPDATE`
  if ((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).menuInitialized) return
  const dishes = await db.dish.findMany({ where: { organizationId }, include: {
    sizes: true, modifierLinks: { include: { group: { include: { options: true } } } }, comboGroups: { include: { options: true } },
  } })
  if (dishes.length) await db.branchMenuItem.createMany({ data: dishes.map(d => ({
    organizationId, branchId, dishId: d.id, price: d.price, isActive: d.isActive,
    optionPrices: {
      sizes: Object.fromEntries(d.sizes.map(s => [s.id, s.price])),
      modifiers: Object.fromEntries(d.modifierLinks.flatMap(l => l.group.options.map(o => [o.id, o.price]))),
      combo: Object.fromEntries(d.comboGroups.flatMap(g => g.options.map(o => [o.id, o.priceDelta]))),
    },
  })), skipDuplicates: true })
  await db.branch.update({ where: { id: branchId }, data: { menuInitialized: true } })
}

export async function ensureOrganizationMenus(db: Db, organizationId: string) {
  for (const b of await db.branch.findMany({ where: { organizationId, menuInitialized: false }, select: { id: true }, orderBy: { id: 'asc' } })) await ensureBranchMenu(db, organizationId, b.id)
}

export async function branchMenu(db: Db, organizationId: string, branchId: string) {
  await ensureBranchMenu(db, organizationId, branchId)
  const rows = await db.branchMenuItem.findMany({ where: { organizationId, branchId } })
  return new Map(rows.map(r => [r.dishId, r]))
}

export async function branchUnavailable(db: Db, organizationId: string, branchId: string) {
  const menu = await branchMenu(db, organizationId, branchId)
  const [dishes, stock] = await Promise.all([
    db.dish.findMany({ where: { organizationId }, select: { id: true, isActive: true, sizes: { select: { id: true } }, category: { select: { isActive: true } } } }),
    db.dishOutOfStock.findMany({ where: { organizationId, branchId }, select: { dishId: true } }),
  ])
  return { menu, off: new Set([...stock.map(s => s.dishId), ...dishes.filter(d => {
    const row = menu.get(d.id)
    return !d.isActive || !d.category.isActive || !row?.isActive || (d.sizes.length > 0 && !d.sizes.some(s => optionPrices(row.optionPrices).sizes[s.id] !== undefined))
  }).map(d => d.id)]) }
}
