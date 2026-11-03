import { roundMoney as regionalRoundMoney } from '../utils/money'
import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission, requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { imageUpload, removeUpload } from '../middleware/imageUpload'
import { logAudit } from '../utils/audit'
import { ensureShifts, currentShift, isValidTimezone, HHMM } from '../utils/menu'
import { dishCosting, ingredientCosts, portionCost } from '../services/foodCost'
import { publish } from '../utils/liveEvents'
import multer from 'multer'
import { Prisma, PrismaClient } from '@prisma/client'
import { applyMenuImport, createMenuTemplate, dishKey, parseMenuWorkbook } from '../services/menuImport'
import { pictureKey, readMenuPackage, storeMenuPictures } from '../services/menuPackage'
import { assertBranchAccess, getBranchScope } from '../utils/branchScope'
import { branchMenu, catalogPrices, ensureOrganizationMenus, optionPrices } from '../services/branchMenu'

const router = Router()
const canView = requireAnyPermission('can_manage_menu', 'can_manage_kitchen', 'can_manage_orders')
const canManage = requirePermission('can_manage_menu')

router.use(authenticate)
router.use((req, res, next) => {
  if (req.method !== 'GET' && !req.path.startsWith('/branches/') && req.path !== '/import') return canManage(req, res, next)
  next()
})
router.use(async (req, _res, next) => {
  if (req.method !== 'GET' && !req.path.startsWith('/branches/') && req.path !== '/import') {
    if ((await getBranchScope(req)).restricted) throw new AppError('Shared catalog changes require organization-wide access. Edit your branch menu instead.', 403, 'BRANCH_FORBIDDEN')
    await ensureOrganizationMenus(prisma, req.user.organizationId)
  }
  next()
})

// the workbook (.xlsx), or a .zip with the workbook and pictures, plus any
// pictures chosen next to the workbook
const menuUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 501 } })

// Every successful menu change (dishes, categories, shifts, timezone) tells
// open guest menus and staff screens to reload.
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) publish({ topic: 'menu', action: 'changed', organizationId: req.user.organizationId })
    })
  }
  next()
})

router.get('/import/template', canManage, async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename="FoodSync-Menu-Import.xlsx"')
  res.send(Buffer.from(await createMenuTemplate().xlsx.writeBuffer()))
})

router.post('/import', canManage, menuUpload.fields([{ name: 'file', maxCount: 1 }, { name: 'images', maxCount: 500 }]), async (req: Request, res: Response) => {
  const branchId = z.string().min(1).optional().parse(req.body.branchId)
  if (branchId) {
    await assertBranchAccess(req, branchId)
    if (!await prisma.branch.findFirst({ where: { id: branchId, organizationId: req.user.organizationId } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  } else if ((await getBranchScope(req)).restricted) throw new AppError('Select your branch before importing', 403, 'BRANCH_FORBIDDEN')
  const files = req.files as Record<string, Express.Multer.File[]> | undefined
  const main = files?.file?.[0]
  if (!main) throw new AppError('Upload an .xlsx menu workbook, or a .zip with the workbook and pictures.', 400, 'INVALID_MENU_IMPORT')
  if (main.size > 100 * 1024 * 1024) throw new AppError('The upload is larger than 100 MB.', 400, 'INVALID_MENU_IMPORT')
  const pkg = await readMenuPackage(main, files?.images ?? [])
  const data = await parseMenuWorkbook(pkg.workbook)
  // every picture named in Dishes must be in the upload
  const missing = data.Dishes.filter((d) => d.image && !pkg.pictures.has(pictureKey(d.image)))
  if (missing.length) throw new AppError(missing.slice(0, 20).map((d) => `Dishes row ${d.row}: picture "${d.image}" was not uploaded.`).join('\n'), 400, 'INVALID_MENU_IMPORT')
  const used = new Set(data.Dishes.filter((d) => d.image).map((d) => pictureKey(d.image)))
  const stored = storeMenuPictures(data.Dishes.filter((d) => d.image).map((d) => ({ dishKey: dishKey(d.category, d.name), picture: pkg.pictures.get(pictureKey(d.image))! })))
  const replaced: string[] = []
  let result
  try {
    result = await prisma.$transaction(async tx => {
      const summary = await applyMenuImport(tx, req.user.organizationId, data, stored, replaced, branchId)
      await logAudit(tx as PrismaClient, { req, action: 'menu_imported', module: 'menu', resourceType: 'menu_import', newData: summary })
      return summary
    }, { timeout: 120000, maxWait: 10000 })
  } catch (e) {
    // nothing was saved: the pictures written for this import go too
    for (const f of stored.values()) removeUpload(f)
    throw e
  }
  for (const f of replaced) removeUpload(f)
  res.json({ ...result, unusedPictures: [...pkg.pictures.keys()].filter((k) => !used.has(k)) })
})

export const dishImageUrl = (dish: { id: string; imagePath: string | null; updatedAt: Date }) =>
  dish.imagePath ? `/public/dishes/${dish.id}/image?v=${dish.updatedAt.getTime()}` : null

const dishInclude = {
  category: { select: { id: true, name: true, isActive: true } },
  shifts: { include: { shift: { select: { id: true, name: true } } } },
}

router.get('/branches/:branchId/dishes', canView, async (req, res) => {
  await assertBranchAccess(req, req.params.branchId)
  const menu = await branchMenu(prisma, req.user.organizationId, req.params.branchId)
  const dishes = await prisma.dish.findMany({ where: { organizationId: req.user.organizationId }, include: {
    ...dishInclude, sizes: true, modifierLinks: { include: { group: { include: { options: true } } } }, comboGroups: { include: { options: { include: { dish: { select: { name: true } } } } } },
    outOfStock: { where: { branchId: req.params.branchId } },
  }, orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }] })
  res.json({ data: dishes.map(d => {
    const row = menu.get(d.id), prices = row ? optionPrices(row.optionPrices) : { sizes: {}, modifiers: {}, combo: {} }
    return { ...serializeDish(d), catalogActive: d.isActive, categoryActive: d.category.isActive,
      price: row?.price ?? d.price, isActive: row?.isActive ?? false, outOfStock: !!d.outOfStock.length,
      optionPrices: prices, priceOptions: {
        sizes: d.sizes.map(s => ({ id: s.id, name: s.name, price: prices.sizes[s.id] ?? s.price })),
        modifiers: d.modifierLinks.flatMap(l => l.group.options.map(o => ({ id: o.id, name: `${l.group.name}: ${o.name}`, price: prices.modifiers[o.id] ?? o.price }))),
        combo: d.comboGroups.flatMap(g => g.options.map(o => ({ id: o.id, name: `${g.name}: ${o.dish.name}`, price: prices.combo[o.id] ?? o.priceDelta }))),
      },
    }
  }) })
})

const branchPricesSchema = z.object({
  price: z.number().finite().min(0).max(1e9), isActive: z.boolean(),
  optionPrices: z.object({ sizes: z.record(z.string(), z.number().finite().min(0).max(1e9)), modifiers: z.record(z.string(), z.number().finite().min(0).max(1e9)), combo: z.record(z.string(), z.number().finite().min(-1e9).max(1e9)) }),
})
router.put('/branches/:branchId/dishes/:dishId', canManage, async (req, res) => {
  await assertBranchAccess(req, req.params.branchId)
  const body = branchPricesSchema.parse(req.body)
  const result = await prisma.$transaction(async tx => {
    await branchMenu(tx, req.user.organizationId, req.params.branchId)
    const defaults = await catalogPrices(tx, req.user.organizationId, req.params.dishId)
    for (const key of ['sizes', 'modifiers', 'combo'] as const) {
      if (Object.keys(body.optionPrices[key]).some(id => defaults[key][id] === undefined)) throw new AppError('An option does not belong to this dish. Reload the menu.', 400, 'INVALID_SELECTION')
      // Save all current option prices explicitly, including newly added sizes.
      if (Object.keys(defaults[key]).some(id => body.optionPrices[key][id] === undefined)) throw new AppError('Include all option prices for this dish', 400, 'INVALID_SELECTION')
    }
    const where = { branchId_dishId: { branchId: req.params.branchId, dishId: req.params.dishId } }
    const old = await tx.branchMenuItem.findUnique({ where })
    const saved = await tx.branchMenuItem.upsert({ where, create: { ...body, organizationId: req.user.organizationId, branchId: req.params.branchId, dishId: req.params.dishId }, update: body })
    await logAudit(tx as PrismaClient, { req, action: 'update', module: 'menu', resourceType: 'branch_menu', resourceId: saved.id, oldData: old, newData: saved })
    return saved
  })
  publish({ topic: 'menu', action: 'branch_menu_updated', organizationId: req.user.organizationId, branchId: req.params.branchId })
  res.json(result)
})

type DishWithRelations = Awaited<ReturnType<typeof findDish>>
const findDish = (id: string, organizationId: string) =>
  prisma.dish.findFirst({ where: { id, organizationId }, include: dishInclude })

function serializeDish(dish: NonNullable<DishWithRelations>) {
  const { imagePath: _imagePath, shifts, ...rest } = dish
  return {
    ...rest,
    imageUrl: dishImageUrl(dish),
    shifts: shifts.map((s) => s.shift),
    shiftIds: shifts.map((s) => s.shiftId),
  }
}

// ── Settings & shifts ──────────────────────────────────────────────────────

// GET /menu/settings
router.get('/settings', canView, async (req: Request, res: Response) => {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const shifts = await ensureShifts(prisma, org.id)
  const running = currentShift(shifts, org.timezone)
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: org.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date())
  res.json({ timezone: org.timezone, localTime, currentShift: running })
})

// PUT /menu/settings
router.put('/settings', canManage, async (req: Request, res: Response) => {
  const { timezone } = z.object({ timezone: z.string().min(1) }).parse(req.body)
  if (!isValidTimezone(timezone)) throw new AppError('Unknown timezone', 400, 'VALIDATION_ERROR')
  await prisma.organization.update({ where: { id: req.user.organizationId }, data: { timezone } })
  res.json({ timezone })
})

// GET /menu/shifts
router.get('/shifts', canView, async (req: Request, res: Response) => {
  const shifts = await ensureShifts(prisma, req.user.organizationId)
  const counts = await prisma.dishShift.groupBy({
    by: ['shiftId'],
    where: { shiftId: { in: shifts.map((s) => s.id) } },
    _count: { _all: true },
  })
  res.json({
    data: shifts.map((s) => ({ ...s, dishCount: counts.find((c) => c.shiftId === s.id)?._count._all ?? 0 })),
  })
})

const shiftSchema = z.object({
  startTime: z.string().regex(HHMM, 'Start time must be HH:mm'),
  endTime: z.string().regex(HHMM, 'End time must be HH:mm'),
  isActive: z.boolean(),
}).partial()

// PUT /menu/shifts/:id
router.put('/shifts/:id', canManage, async (req: Request, res: Response) => {
  const body = shiftSchema.parse(req.body)
  const shift = await prisma.menuShift.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!shift) throw new AppError('Shift not found', 404, 'NOT_FOUND')
  const updated = await prisma.menuShift.update({ where: { id: shift.id }, data: body })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'menu_shift', resourceId: shift.id, resourceRef: shift.name, oldData: shift, newData: updated })
  res.json(updated)
})

// ── Categories ─────────────────────────────────────────────────────────────

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().max(300).optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

// GET /menu/categories
router.get('/categories', canView, async (req: Request, res: Response) => {
  const categories = await prisma.menuCategory.findMany({
    where: { organizationId: req.user.organizationId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { dishes: true } } },
  })
  res.json({ data: categories.map(({ _count, ...c }) => ({ ...c, dishCount: _count.dishes })) })
})

// POST /menu/categories
router.post('/categories', canManage, async (req: Request, res: Response) => {
  const body = categorySchema.parse(req.body)
  const category = await prisma.menuCategory.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(category)
})

// PUT /menu/categories/:id
router.put('/categories/:id', canManage, async (req: Request, res: Response) => {
  const body = updateSchema(categorySchema).parse(req.body)
  const category = await prisma.menuCategory.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')
  const updated = await prisma.menuCategory.update({ where: { id: category.id }, data: body })
  res.json(updated)
})

// DELETE /menu/categories/:id
router.delete('/categories/:id', canManage, async (req: Request, res: Response) => {
  const category = await prisma.menuCategory.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { _count: { select: { dishes: true } } },
  })
  if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')
  if (category._count.dishes > 0) {
    throw new AppError('Move or delete the dishes in this category first', 400, 'CATEGORY_IN_USE')
  }
  await prisma.menuCategory.delete({ where: { id: category.id } })
  res.json({ message: 'Category deleted' })
})

// ── Dishes ─────────────────────────────────────────────────────────────────

const dishSchema = z.object({
  categoryId: z.string().min(1, 'Category is required'),
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).optional().nullable(),
  price: z.number().min(0, 'Price cannot be negative'),
  shiftIds: z.array(z.string()).min(1, 'Pick at least one shift'),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

async function assertCategoryAndShifts(organizationId: string, categoryId?: string, shiftIds?: string[]) {
  if (categoryId) {
    const category = await prisma.menuCategory.findFirst({ where: { id: categoryId, organizationId } })
    if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')
  }
  if (shiftIds) {
    const count = await prisma.menuShift.count({ where: { id: { in: shiftIds }, organizationId } })
    if (count !== new Set(shiftIds).size) throw new AppError('Unknown shift selected', 400, 'VALIDATION_ERROR')
  }
}

// GET /menu/dishes
router.get('/dishes', canView, async (req: Request, res: Response) => {
  const { categoryId, shiftId, search, status } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (categoryId) where.categoryId = categoryId
  if (shiftId) where.shifts = { some: { shiftId } }
  if (search) where.name = { contains: search, mode: 'insensitive' }
  if (status === 'active') where.isActive = true
  if (status === 'inactive') where.isActive = false

  const dishes = await prisma.dish.findMany({
    where,
    include: dishInclude,
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
  })
  res.json({ data: dishes.map(serializeDish) })
})

// ── Modifier groups ("Spice level", "Extra toppings") ─────────────────────

const modifierGroupSchema = z.object({
  name: z.string().trim().min(1).max(60),
  minSelect: z.number().int().min(0).max(20).default(0),
  maxSelect: z.number().int().min(1).max(20).default(1),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  options: z.array(z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(60),
    price: z.number().min(0).max(1_000_000).default(0),
    itemId: z.string().optional().nullable(),
    itemQuantity: z.number().min(0).default(0),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })).min(1, 'Add at least one option').max(60),
}).refine((g) => g.minSelect <= g.maxSelect, { message: 'Minimum cannot be more than maximum', path: ['minSelect'] })

const groupInclude = { options: { orderBy: [{ sortOrder: 'asc' as const }, { name: 'asc' as const }] }, _count: { select: { dishes: true } } }

router.get('/modifier-groups', canView, async (req: Request, res: Response) => {
  res.json({ data: await prisma.modifierGroup.findMany({ where: { organizationId: req.user.organizationId }, include: groupInclude, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) })
})

async function saveGroupOptions(tx: Prisma.TransactionClient, organizationId: string, groupId: string, options: z.infer<typeof modifierGroupSchema>['options']) {
  const itemIds = [...new Set(options.map((o) => o.itemId).filter(Boolean) as string[])]
  if (itemIds.length && (await tx.item.count({ where: { id: { in: itemIds }, organizationId } })) !== itemIds.length) throw new AppError('An option uses an unknown inventory item', 400, 'VALIDATION_ERROR')
  const keep = options.map((o) => o.id).filter(Boolean) as string[]
  await tx.modifierOption.deleteMany({ where: { groupId, id: { notIn: keep } } })
  for (const [sortOrder, o] of options.entries()) {
    const data = { name: o.name, price: o.price, itemId: o.itemId || null, itemQuantity: o.itemId ? o.itemQuantity : 0, isDefault: o.isDefault, isActive: o.isActive, sortOrder }
    if (o.id && (await tx.modifierOption.findFirst({ where: { id: o.id, groupId } }))) await tx.modifierOption.update({ where: { id: o.id }, data })
    else await tx.modifierOption.create({ data: { ...data, groupId } })
  }
}

router.post('/modifier-groups', canManage, async (req: Request, res: Response) => {
  const { options, ...body } = modifierGroupSchema.parse(req.body)
  const group = await prisma.$transaction(async (tx) => {
    const g = await tx.modifierGroup.create({ data: { ...body, organizationId: req.user.organizationId } })
    await saveGroupOptions(tx, req.user.organizationId, g.id, options)
    return tx.modifierGroup.findUniqueOrThrow({ where: { id: g.id }, include: groupInclude })
  })
  await logAudit(prisma, { req, action: 'create', module: 'menu', resourceType: 'modifier_group', resourceId: group.id, resourceRef: group.name, newData: { ...body, options } })
  res.status(201).json(group)
})

router.put('/modifier-groups/:id', canManage, async (req: Request, res: Response) => {
  const existing = await prisma.modifierGroup.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!existing) throw new AppError('Modifier group not found', 404, 'NOT_FOUND')
  const { options, ...body } = modifierGroupSchema.parse(req.body)
  const group = await prisma.$transaction(async (tx) => {
    await tx.modifierGroup.update({ where: { id: existing.id }, data: body })
    await saveGroupOptions(tx, req.user.organizationId, existing.id, options)
    return tx.modifierGroup.findUniqueOrThrow({ where: { id: existing.id }, include: groupInclude })
  })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'modifier_group', resourceId: group.id, resourceRef: group.name, newData: { ...body, options } })
  res.json(group)
})

router.delete('/modifier-groups/:id', canManage, async (req: Request, res: Response) => {
  const existing = await prisma.modifierGroup.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!existing) throw new AppError('Modifier group not found', 404, 'NOT_FOUND')
  await prisma.modifierGroup.delete({ where: { id: existing.id } })
  await logAudit(prisma, { req, action: 'delete', module: 'menu', resourceType: 'modifier_group', resourceId: existing.id, resourceRef: existing.name })
  res.json({ deleted: true })
})

// ── A dish's sizes, modifier groups and combo choices ─────────────────────

const dishOptionsSchema = z.object({
  sizes: z.array(z.object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(40),
    price: z.number().min(0).max(1_000_000),
    recipeFactor: z.number().min(0).max(20).default(1),
    isDefault: z.boolean().default(false),
  })).max(10).default([]),
  modifierGroups: z.array(z.object({
    groupId: z.string().min(1),
    minSelect: z.number().int().min(0).max(20).optional().nullable(),
    maxSelect: z.number().int().min(1).max(20).optional().nullable(),
    freeCount: z.number().int().min(0).max(20).default(0),
    excludedOptionIds: z.array(z.string()).default([]),
  })).max(20).default([]),
  isCombo: z.boolean().default(false),
  comboGroups: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    minSelect: z.number().int().min(0).max(10).default(1),
    maxSelect: z.number().int().min(1).max(10).default(1),
    options: z.array(z.object({
      dishId: z.string().min(1),
      sizeId: z.string().optional().nullable(),
      priceDelta: z.number().min(-1_000_000).max(1_000_000).default(0),
      isDefault: z.boolean().default(false),
    })).min(1, 'Each combo choice needs at least one dish').max(40),
  })).max(10).default([]),
}).superRefine((b, ctx) => {
  if (b.sizes.filter((s) => s.isDefault).length > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sizes'], message: 'Only one default size' })
  if (new Set(b.sizes.map((s) => s.name.toLowerCase())).size !== b.sizes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sizes'], message: 'Size names must differ' })
  if (b.isCombo && b.comboGroups.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comboGroups'], message: 'A combo needs at least one choice' })
  if (!b.isCombo && b.comboGroups.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isCombo'], message: 'Turn on "combo" to add combo choices' })
  for (const [i, g] of b.comboGroups.entries()) if (g.minSelect > g.maxSelect) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comboGroups', i, 'minSelect'], message: 'Minimum cannot be more than maximum' })
})

async function dishOptionsPayload(dishId: string) {
  const d = await prisma.dish.findUniqueOrThrow({
    where: { id: dishId },
    select: {
      id: true, isCombo: true,
      sizes: { orderBy: { sortOrder: 'asc' } },
      modifierLinks: { orderBy: { sortOrder: 'asc' } },
      comboGroups: { orderBy: { sortOrder: 'asc' }, include: { options: { orderBy: { sortOrder: 'asc' } } } },
    },
  })
  return {
    isCombo: d.isCombo,
    sizes: d.sizes.map(({ id, name, price, recipeFactor, isDefault }) => ({ id, name, price, recipeFactor, isDefault })),
    modifierGroups: d.modifierLinks.map(({ groupId, minSelect, maxSelect, freeCount, excludedOptionIds }) => ({ groupId, minSelect, maxSelect, freeCount, excludedOptionIds })),
    comboGroups: d.comboGroups.map((g) => ({ name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, options: g.options.map(({ dishId, sizeId, priceDelta, isDefault }) => ({ dishId, sizeId, priceDelta, isDefault })) })),
  }
}

router.get('/dishes/:id/options', canView, async (req: Request, res: Response) => {
  const dish = await prisma.dish.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, select: { id: true } })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  res.json(await dishOptionsPayload(dish.id))
})

router.put('/dishes/:id/options', canManage, async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const dish = await prisma.dish.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  const body = dishOptionsSchema.parse(req.body)
  if (new Set(body.comboGroups.map(g => g.name.toLowerCase())).size !== body.comboGroups.length) throw new AppError('Combo group names must be unique', 400, 'VALIDATION_ERROR')
  const groupIds = body.modifierGroups.map((g) => g.groupId)
  if (new Set(groupIds).size !== groupIds.length) throw new AppError('A modifier group is linked twice', 400, 'VALIDATION_ERROR')
  if (groupIds.length && (await prisma.modifierGroup.count({ where: { id: { in: groupIds }, organizationId: orgId } })) !== groupIds.length) throw new AppError('Unknown modifier group', 400, 'VALIDATION_ERROR')
  const componentIds = [...new Set(body.comboGroups.flatMap((g) => g.options.map((o) => o.dishId)))]
  if (componentIds.includes(dish.id)) throw new AppError('A combo cannot contain itself', 400, 'VALIDATION_ERROR')
  const components = await prisma.dish.findMany({ where: { id: { in: componentIds }, organizationId: orgId }, select: { id: true, isCombo: true, sizes: { select: { id: true } } } })
  if (components.length !== componentIds.length) throw new AppError('A combo choice uses an unknown dish', 400, 'VALIDATION_ERROR')
  if (components.some((c) => c.isCombo)) throw new AppError('A combo cannot contain another combo', 400, 'VALIDATION_ERROR')
  for (const g of body.comboGroups) for (const o of g.options) {
    if (o.sizeId && !components.find((c) => c.id === o.dishId)!.sizes.some((s) => s.id === o.sizeId)) throw new AppError('A combo choice uses a size of another dish', 400, 'VALIDATION_ERROR')
  }
  // a dish used inside a combo stays a plain dish
  if (body.isCombo && (await prisma.comboOption.count({ where: { dishId: dish.id } })) > 0) throw new AppError('This dish is a choice in another combo, so it cannot be a combo itself', 400, 'VALIDATION_ERROR')

  await prisma.$transaction(async (tx) => {
    // Keep size IDs stable: combo choices and carts refer to them.
    const existing = await tx.dishSize.findMany({ where: { dishId: dish.id } })
    const retained = body.sizes.map((s) => {
      const found = s.id ? existing.find((a) => a.id === s.id) : existing.find((a) => a.name.toLowerCase() === s.name.toLowerCase())
      if (s.id && !found) throw new AppError('Unknown size on this dish', 400, 'VALIDATION_ERROR')
      return found?.id
    })
    if (new Set(retained.filter(Boolean)).size !== retained.filter(Boolean).length) throw new AppError('A size is included twice', 400, 'VALIDATION_ERROR')
    const removed = existing.filter((s) => !retained.includes(s.id)).map((s) => s.id)
    if (removed.length && await tx.comboOption.count({ where: { sizeId: { in: removed }, group: { dishId: { not: dish.id } } } })) throw new AppError('Remove this size from combo choices before deleting it', 400, 'VALIDATION_ERROR')
    await tx.dishSize.deleteMany({ where: { dishId: dish.id, id: { in: removed } } })
    const hasDefault = body.sizes.some((x) => x.isDefault)
    for (const [sortOrder, sz] of body.sizes.entries()) {
      const { id: _id, ...fields } = sz
      const data = { ...fields, dishId: dish.id, sortOrder, isDefault: sz.isDefault || (!hasDefault && sortOrder === 0) }
      if (retained[sortOrder]) await tx.dishSize.update({ where: { id: retained[sortOrder] }, data })
      else await tx.dishSize.create({ data })
    }
    await tx.dishModifierGroup.deleteMany({ where: { dishId: dish.id } })
    for (const [sortOrder, l] of body.modifierGroups.entries()) await tx.dishModifierGroup.create({ data: { ...l, dishId: dish.id, sortOrder } })
    // Branch price snapshots and saved carts require stable combo option IDs.
    const oldGroups = await tx.comboGroup.findMany({ where: { dishId: dish.id }, include: { options: true } })
    const keptGroups: string[] = []
    for (const [sortOrder, g] of body.comboGroups.entries()) {
      const old = oldGroups.find(x => x.name.toLowerCase() === g.name.toLowerCase())
      const data = { dishId: dish.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder }
      const group = old ? await tx.comboGroup.update({ where: { id: old.id }, data }) : await tx.comboGroup.create({ data })
      keptGroups.push(group.id)
      const keptOptions: string[] = []
      for (const [i, o] of g.options.entries()) {
        const previous = old?.options.find(x => !keptOptions.includes(x.id) && x.dishId === o.dishId && x.sizeId === (o.sizeId || null))
        const fields = { groupId: group.id, dishId: o.dishId, sizeId: o.sizeId || null, priceDelta: o.priceDelta, isDefault: o.isDefault, sortOrder: i }
        const option = previous ? await tx.comboOption.update({ where: { id: previous.id }, data: fields }) : await tx.comboOption.create({ data: fields })
        keptOptions.push(option.id)
      }
      await tx.comboOption.deleteMany({ where: { groupId: group.id, id: { notIn: keptOptions } } })
    }
    await tx.comboGroup.deleteMany({ where: { dishId: dish.id, id: { notIn: keptGroups } } })
    await tx.dish.update({ where: { id: dish.id }, data: { isCombo: body.isCombo } })
  })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'dish_options', resourceId: dish.id, resourceRef: dish.name, newData: body })
  res.json(await dishOptionsPayload(dish.id))
})

// GET /menu/dishes/:id
router.get('/dishes/:id', canView, async (req: Request, res: Response) => {
  const dish = await findDish(req.params.id, req.user.organizationId)
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  res.json(serializeDish(dish))
})

// POST /menu/dishes
router.post('/dishes', canManage, async (req: Request, res: Response) => {
  const { shiftIds, ...body } = dishSchema.parse(req.body)
  await assertCategoryAndShifts(req.user.organizationId, body.categoryId, shiftIds)
  const created = await prisma.dish.create({
    data: {
      ...body,
      organizationId: req.user.organizationId,
      shifts: { create: [...new Set(shiftIds)].map((shiftId) => ({ shiftId })) },
    },
  })
  await logAudit(prisma, { req, action: 'create', module: 'menu', resourceType: 'dish', resourceId: created.id, resourceRef: created.name, newData: { ...body, shiftIds } })
  res.status(201).json(serializeDish((await findDish(created.id, req.user.organizationId))!))
})

// PUT /menu/dishes/:id
router.put('/dishes/:id', canManage, async (req: Request, res: Response) => {
  const { shiftIds, ...body } = updateSchema(dishSchema).parse(req.body)
  const dish = await findDish(req.params.id, req.user.organizationId)
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  await assertCategoryAndShifts(req.user.organizationId, body.categoryId, shiftIds)

  await prisma.$transaction(async (tx) => {
    if (shiftIds) {
      await tx.dishShift.deleteMany({ where: { dishId: dish.id } })
      await tx.dishShift.createMany({ data: [...new Set(shiftIds)].map((shiftId) => ({ dishId: dish.id, shiftId })) })
    }
    await tx.dish.update({ where: { id: dish.id }, data: body })
  })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'dish', resourceId: dish.id, resourceRef: dish.name, oldData: serializeDish(dish), newData: { ...body, shiftIds } })
  res.json(serializeDish((await findDish(dish.id, req.user.organizationId))!))
})

// POST /menu/dishes/:id/image  (multipart, field "image")
router.post('/dishes/:id/image', canManage, imageUpload('menu').single('image'), async (req: Request, res: Response) => {
  const file = req.file
  if (!file) throw new AppError('No image uploaded', 400, 'VALIDATION_ERROR')
  const dish = await prisma.dish.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!dish) {
    removeUpload(file.path)
    throw new AppError('Dish not found', 404, 'NOT_FOUND')
  }
  removeUpload(dish.imagePath)
  await prisma.dish.update({ where: { id: dish.id }, data: { imagePath: file.path } })
  res.json(serializeDish((await findDish(dish.id, req.user.organizationId))!))
})

// DELETE /menu/dishes/:id/image
router.delete('/dishes/:id/image', canManage, async (req: Request, res: Response) => {
  const dish = await prisma.dish.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  removeUpload(dish.imagePath)
  await prisma.dish.update({ where: { id: dish.id }, data: { imagePath: null } })
  res.json(serializeDish((await findDish(dish.id, req.user.organizationId))!))
})

// DELETE /menu/dishes/:id — a dish that was ever ordered stays on record
// (past orders reference it) and is switched off instead.
router.delete('/dishes/:id', canManage, async (req: Request, res: Response) => {
  const dish = await prisma.dish.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { _count: { select: { orderItems: true } } },
  })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')

  if (dish._count.orderItems > 0) {
    await prisma.dish.update({ where: { id: dish.id }, data: { isActive: false } })
    await logAudit(prisma, { req, action: 'deactivate', module: 'menu', resourceType: 'dish', resourceId: dish.id, resourceRef: dish.name })
    res.json({ archived: true, message: 'This dish is on past orders, so it was deactivated instead of deleted' })
    return
  }

  await prisma.dish.delete({ where: { id: dish.id } })
  removeUpload(dish.imagePath)
  await logAudit(prisma, { req, action: 'delete', module: 'menu', resourceType: 'dish', resourceId: dish.id, resourceRef: dish.name })
  res.json({ archived: false, message: 'Dish deleted' })
})

// ── Recipes & food cost ─────────────────────────────────────────────────────

const round2 = (n: number) => regionalRoundMoney(n)

// Tax rate used to turn a VAT-inclusive menu price into net revenue
async function costingBranch(organizationId: string, branchId?: string) {
  const branch = await prisma.branch.findFirst({
    where: { organizationId, ...(branchId ? { id: branchId } : { isActive: true }) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, vatEnabled: true, vatRate: true },
  })
  return branch
}

// GET /menu/costing?branchId= — every dish with its recipe cost, food cost %
// and profit per plate (prices are VAT-inclusive; cost % is against the net)
router.get('/costing', canView, async (req: Request, res: Response) => {
  const branch = await costingBranch(req.user.organizationId, (req.query.branchId as string) || undefined)
  const { dishes, costs } = await dishCosting(prisma, req.user.organizationId, branch?.id)
  const taxRate = branch?.vatEnabled ? branch.vatRate : 0
  res.json({
    branch,
    taxRate,
    data: dishes.map((d) => {
      const cost = round2(portionCost(d.ingredients, costs))
      const netPrice = round2(taxRate > 0 ? (d.price * 100) / (100 + taxRate) : d.price)
      return {
        id: d.id,
        name: d.name,
        isActive: d.isActive,
        category: d.category,
        imageUrl: dishImageUrl(d),
        price: d.price,
        netPrice,
        cost,
        profit: round2(netPrice - cost),
        foodCostPct: netPrice > 0 && d.ingredients.length ? round2((cost / netPrice) * 100) : null,
        ingredientCount: d.ingredients.length,
        // ingredients with no cost yet (never purchased, no catalog cost)
        uncosted: d.ingredients.filter((i) => !(costs.get(i.itemId) ?? 0)).map((i) => i.item.name),
      }
    }),
  })
})

// GET /menu/recipe-items — inventory items that can go into a recipe
router.get('/recipe-items', canView, async (req: Request, res: Response) => {
  const branchId = (req.query.branchId as string) || undefined
  const items = await prisma.item.findMany({
    where: { organizationId: req.user.organizationId, isActive: true },
    select: { id: true, code: true, name: true, unit: true, itemCategory: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  const costs = await ingredientCosts(prisma, req.user.organizationId, items.map((i) => i.id), branchId)
  res.json({ data: items.map((i) => ({ id: i.id, code: i.code, name: i.name, unit: i.unit, category: i.itemCategory?.name ?? null, unitCost: round2(costs.get(i.id) ?? 0) })) })
})

// GET /menu/dishes/:id/recipe
router.get('/dishes/:id/recipe', canView, async (req: Request, res: Response) => {
  const dish = await prisma.dish.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { ingredients: { include: { item: { select: { id: true, code: true, name: true, unit: true } } }, orderBy: { sortOrder: 'asc' } } },
  })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  const branch = await costingBranch(req.user.organizationId, (req.query.branchId as string) || undefined)
  const costs = await ingredientCosts(prisma, req.user.organizationId, dish.ingredients.map((i) => i.itemId), branch?.id)
  res.json({
    dishId: dish.id,
    price: dish.price,
    taxRate: branch?.vatEnabled ? branch.vatRate : 0,
    ingredients: dish.ingredients.map((i) => ({
      itemId: i.itemId, item: i.item, quantity: i.quantity, wastePct: i.wastePct, unitCost: round2(costs.get(i.itemId) ?? 0),
    })),
  })
})

const recipeSchema = z.object({
  ingredients: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().positive('Quantity must be more than 0').max(100_000),
    wastePct: z.coerce.number().min(0).max(90, 'Waste can be at most 90%').default(0),
  })).max(60),
})

// PUT /menu/dishes/:id/recipe — replaces the whole recipe
router.put('/dishes/:id/recipe', canManage, async (req: Request, res: Response) => {
  const body = recipeSchema.parse(req.body)
  const dish = await prisma.dish.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!dish) throw new AppError('Dish not found', 404, 'NOT_FOUND')
  const ids = body.ingredients.map((i) => i.itemId)
  if (new Set(ids).size !== ids.length) throw new AppError('Each ingredient can appear only once — combine the quantities', 400, 'VALIDATION_ERROR')
  const valid = await prisma.item.count({ where: { id: { in: ids }, organizationId: req.user.organizationId } })
  if (valid !== ids.length) throw new AppError('Unknown ingredient', 400, 'VALIDATION_ERROR')

  await prisma.$transaction([
    prisma.dishIngredient.deleteMany({ where: { dishId: dish.id } }),
    prisma.dishIngredient.createMany({ data: body.ingredients.map((i, n) => ({ dishId: dish.id, itemId: i.itemId, quantity: i.quantity, wastePct: i.wastePct, sortOrder: n })) }),
  ])
  await logAudit(prisma, { req, action: 'recipe_updated', module: 'menu', resourceType: 'dish', resourceId: dish.id, resourceRef: dish.name, newData: body })
  res.json({ ok: true, ingredientCount: body.ingredients.length })
})

export default router
