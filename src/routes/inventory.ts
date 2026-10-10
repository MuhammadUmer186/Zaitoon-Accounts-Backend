import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission } from '../middleware/authorize'
import { upload } from '../middleware/upload'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { applyStockIn, applyStockOut } from '../utils/stock'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, resolveMappedAccount } from '../utils/ledger'
import { assertBranchAccess, branchFilter, getBranchScope } from '../utils/branchScope'

const router = Router()

router.use(authenticate)

const categorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  unit: z.string().min(1),
})

const itemSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  categoryId: z.string().optional(),
  unit: z.string().min(1).optional(),
  costPrice: z.number().min(0).default(0),
  reorderPoint: z.number().min(0).default(0),
})

// Stock Out is one of two movements out of a branch store:
//  - branch_transfer: store → another branch's store (toBranchId)
//  - section:         store → a section of the same branch (sectionId), e.g. Juices/Broast/Kitchen
const stockOutSchema = z
  .object({
    type: z.enum(['branch_transfer', 'section']),
    branchId: z.string(),
    toBranchId: z.string().optional(),
    sectionId: z.string().optional(),
    stockOutDate: z.string().or(z.date()).optional(),
    reason: z.string().optional(),
    notes: z.string().optional(),
    items: z.array(z.object({
      itemId: z.string(),
      quantity: z.number().positive(),
    })).min(1),
  })
  .refine((b) => b.type !== 'branch_transfer' || !!b.toBranchId, { message: 'Destination branch is required', path: ['toBranchId'] })
  .refine((b) => b.type !== 'section' || !!b.sectionId, { message: 'Section is required', path: ['sectionId'] })

const sectionSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
})

const wastageSchema = z.object({
  branchId: z.string(),
  reportDate: z.string().or(z.date()),
  notes: z.string().optional(),
  items: z.array(z.object({
    itemId: z.string(),
    quantity: z.number().positive(),
    unitCost: z.number(),
    totalValue: z.number(),
    reason: z.string().optional(),
  })),
})

// GET /inventory/categories — the item catalog's categories, each carrying
// a default unit of measurement (kg, litre, gallon, ...) for items in it
router.get('/categories', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_approve_wastage', 'can_create_purchasing_entry', 'can_create_purchase_order', 'can_approve_purchase_order', 'can_view_reports'), async (req: Request, res: Response) => {
  const categories = await prisma.itemCategory.findMany({
    where: { organizationId: req.user.organizationId, isActive: true },
    orderBy: { name: 'asc' },
    include: { _count: { select: { items: true } } },
  })
  res.json({ data: categories })
})

// POST /inventory/categories
router.post('/categories', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const body = categorySchema.parse(req.body)
  const category = await prisma.itemCategory.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(category)
})

// PUT /inventory/categories/:id
router.put('/categories/:id', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const category = await prisma.itemCategory.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')

  const body = categorySchema.partial().parse(req.body)
  const updated = await prisma.itemCategory.update({ where: { id: req.params.id }, data: body })
  res.json(updated)
})

// DELETE /inventory/categories/:id
router.delete('/categories/:id', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const category = await prisma.itemCategory.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')

  const inUse = await prisma.item.count({ where: { categoryId: req.params.id } })
  if (inUse > 0) {
    await prisma.itemCategory.update({ where: { id: req.params.id }, data: { isActive: false } })
    return res.json({ message: 'Category deactivated (has existing items)' })
  }

  await prisma.itemCategory.delete({ where: { id: req.params.id } })
  res.json({ message: 'Category deleted' })
})

// GET /inventory/stock
router.get('/stock', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_approve_wastage', 'can_create_purchasing_entry', 'can_view_reports'), async (req: Request, res: Response) => {
  const { branchId, search, lowStock } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId, quantityOnHand: { gt: 0 } }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf

  const [stocks, org] = await Promise.all([
    prisma.branchStock.findMany({
      where,
      include: {
        item: true,
        branch: { select: { id: true, name: true } },
      },
      orderBy: [{ branch: { name: 'asc' } }, { item: { name: 'asc' } }],
    }),
    prisma.organization.findUnique({ where: { id: req.user.organizationId }, select: { lowStockThreshold: true } }),
  ])
  const globalThreshold = org?.lowStockThreshold ?? null
  const thresholdFor = (st: { reorderPoint: number }) => globalThreshold ?? st.reorderPoint

  let filtered = stocks

  if (search) {
    const s = search.toLowerCase()
    filtered = filtered.filter(
      (st) =>
        st.item.name.toLowerCase().includes(s) ||
        st.item.code.toLowerCase().includes(s)
    )
  }

  if (lowStock === 'true') {
    filtered = filtered.filter((st) => st.quantityOnHand < thresholdFor(st))
  }

  const data = filtered.map((st) => ({
    id: st.id,
    organizationId: st.organizationId,
    branchId: st.branchId,
    branchName: st.branch.name,
    itemId: st.itemId,
    itemName: st.item.name,
    itemCode: st.item.code,
    unit: st.item.unit,
    quantityOnHand: st.quantityOnHand,
    averageCost: st.averageCost,
    totalValue: st.totalValue,
    reorderPoint: st.reorderPoint,
    isLowStock: st.quantityOnHand < thresholdFor(st),
    lastUpdated: st.lastUpdated,
  }))

  res.json({ data, total: data.length })
})

// GET /inventory/items
router.get('/items', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_approve_wastage', 'can_create_purchasing_entry', 'can_create_purchase_order', 'can_approve_purchase_order', 'can_view_reports'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { search, categoryId } = req.query as Record<string, string>

  const where = {
    organizationId: req.user.organizationId,
    isActive: true,
    ...(categoryId && { categoryId }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { code: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
  }

  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { name: 'asc' },
      include: { itemCategory: { select: { id: true, name: true, unit: true } } },
    }),
    prisma.item.count({ where }),
  ])

  const data = items.map((i) => ({ ...i, categoryName: i.itemCategory?.name ?? i.category ?? null }))
  res.json(paginatedResponse(data, total, page, limit))
})

// POST /inventory/items — add a new product to the catalog
router.post('/items', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const body = itemSchema.parse(req.body)

  let unit = body.unit
  if (body.categoryId) {
    const category = await prisma.itemCategory.findFirst({
      where: { id: body.categoryId, organizationId: req.user.organizationId },
    })
    if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')
    unit = unit ?? category.unit
  }

  const item = await prisma.item.create({
    data: { ...body, unit: unit ?? 'kg', organizationId: req.user.organizationId },
    include: { itemCategory: { select: { id: true, name: true, unit: true } } },
  })
  res.status(201).json(item)
})

// PUT /inventory/items/:id
router.put('/items/:id', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const item = await prisma.item.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  const body = itemSchema.partial().parse(req.body)
  if (body.categoryId) {
    const category = await prisma.itemCategory.findFirst({
      where: { id: body.categoryId, organizationId: req.user.organizationId },
    })
    if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')
  }

  const updated = await prisma.item.update({
    where: { id: req.params.id },
    data: body,
    include: { itemCategory: { select: { id: true, name: true, unit: true } } },
  })
  res.json(updated)
})

// DELETE /inventory/items/:id — items always have a BranchStock row per
// branch (created up front) and often purchase/movement history, so this
// always deactivates rather than hard-deleting.
router.delete('/items/:id', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const item = await prisma.item.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  await prisma.item.update({ where: { id: req.params.id }, data: { isActive: false } })
  res.json({ message: 'Item deactivated' })
})

// ── Branch sections (Juices, Broast, Kitchen, ...) ──────────────────────────

// GET /inventory/sections?branchId=&includeInactive=
router.get('/sections', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_view_reports'), async (req: Request, res: Response) => {
  const { branchId, includeInactive } = req.query as Record<string, string>
  const bf = await branchFilter(req, branchId)
  const sections = await prisma.branchSection.findMany({
    where: {
      organizationId: req.user.organizationId,
      ...(bf && { branchId: bf }),
      ...(includeInactive !== 'true' && { isActive: true }),
    },
    include: { branch: { select: { id: true, name: true } }, _count: { select: { stockOuts: true } } },
    orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
  })
  res.json({ data: sections.map((s) => ({ ...s, branchName: s.branch.name, stockOutCount: s._count.stockOuts })) })
})

// POST /inventory/sections — create a section in one branch, or (with
// allBranches: true) the same-named section in every active branch that
// doesn't already have it.
router.post('/sections', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const body = sectionSchema.extend({
    branchId: z.string().optional(),
    allBranches: z.boolean().optional(),
  }).parse(req.body)
  if (!body.allBranches && !body.branchId) throw new AppError('Branch is required', 400, 'VALIDATION_ERROR')
  if ((await getBranchScope(req)).restricted) {
    if (body.allBranches) throw new AppError('You can only create sections in your own branch', 403, 'BRANCH_FORBIDDEN')
    await assertBranchAccess(req, body.branchId)
  }

  const branches = await prisma.branch.findMany({
    where: {
      organizationId: req.user.organizationId,
      ...(body.allBranches ? { isActive: true } : { id: body.branchId }),
    },
    select: { id: true },
  })
  if (branches.length === 0) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const created = []
  for (const b of branches) {
    const existing = await prisma.branchSection.findUnique({ where: { branchId_name: { branchId: b.id, name: body.name } } })
    if (existing) {
      if (!existing.isActive) {
        created.push(await prisma.branchSection.update({ where: { id: existing.id }, data: { isActive: true, description: body.description } }))
      } else if (!body.allBranches) {
        throw new AppError(`Section "${body.name}" already exists in this branch`, 400, 'DUPLICATE')
      }
      continue
    }
    created.push(await prisma.branchSection.create({
      data: { organizationId: req.user.organizationId, branchId: b.id, name: body.name, description: body.description },
    }))
  }
  res.status(201).json({ data: created, created: created.length })
})

// PUT /inventory/sections/:id
router.put('/sections/:id', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const section = await prisma.branchSection.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!section) throw new AppError('Section not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, section.branchId)
  const body = sectionSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body)
  const updated = await prisma.branchSection.update({ where: { id: section.id }, data: body })
  res.json(updated)
})

// DELETE /inventory/sections/:id — deactivates when the section has stock-out
// history (so past issues keep their section), otherwise deletes.
router.delete('/sections/:id', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const section = await prisma.branchSection.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!section) throw new AppError('Section not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, section.branchId)
  const inUse = await prisma.stockOut.count({ where: { sectionId: section.id } })
  if (inUse > 0) {
    await prisma.branchSection.update({ where: { id: section.id }, data: { isActive: false } })
    return res.json({ message: 'Section deactivated (has stock out history)' })
  }
  await prisma.branchSection.delete({ where: { id: section.id } })
  res.json({ message: 'Section deleted' })
})

// GET /inventory/sections/summary?branchId=&fromDate=&toDate= — what each
// section has received from its branch store: total value, number of issues,
// and per-item quantities.
router.get('/sections/summary', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_view_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate } = req.query as Record<string, string>
  const bf = await branchFilter(req, branchId)
  const movements = await prisma.stockMovement.findMany({
    where: {
      organizationId: req.user.organizationId,
      sectionId: { not: null },
      ...(bf && { branchId: bf }),
      ...((fromDate || toDate) && {
        createdAt: {
          ...(fromDate && { gte: new Date(fromDate) }),
          ...(toDate && { lte: new Date(`${toDate}T23:59:59.999`) }),
        },
      }),
    },
    include: { item: { select: { id: true, name: true, code: true, unit: true } } },
  })
  const sections = await prisma.branchSection.findMany({
    where: { organizationId: req.user.organizationId, ...(bf && { branchId: bf }) },
    include: { branch: { select: { name: true } } },
    orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
  })

  const bySection = new Map<string, { totalValue: number; refs: Set<string>; items: Map<string, { itemId: string; itemName: string; itemCode: string; unit: string; quantity: number; value: number }> }>()
  for (const m of movements) {
    const key = m.sectionId!
    let entry = bySection.get(key)
    if (!entry) { entry = { totalValue: 0, refs: new Set(), items: new Map() }; bySection.set(key, entry) }
    entry.totalValue += m.totalValue
    if (m.referenceId) entry.refs.add(m.referenceId)
    const it = entry.items.get(m.itemId) ?? { itemId: m.itemId, itemName: m.item.name, itemCode: m.item.code, unit: m.item.unit, quantity: 0, value: 0 }
    it.quantity += Math.abs(m.quantity)
    it.value += m.totalValue
    entry.items.set(m.itemId, it)
  }

  const data = sections
    .filter((s) => s.isActive || bySection.has(s.id))
    .map((s) => {
      const entry = bySection.get(s.id)
      return {
        sectionId: s.id,
        sectionName: s.name,
        branchId: s.branchId,
        branchName: s.branch.name,
        isActive: s.isActive,
        issueCount: entry?.refs.size ?? 0,
        totalValue: entry?.totalValue ?? 0,
        items: entry ? [...entry.items.values()].sort((a, b) => b.value - a.value) : [],
      }
    })
  res.json({ data })
})

// ── Stock Out ────────────────────────────────────────────────────────────────

// POST /inventory/stock-out — applied immediately, no approval step:
//  - branch_transfer: moves stock at the source's weighted-average cost into
//    the destination branch store. Inventory stays inventory, so no GL entry.
//  - section: issues stock from the branch store to one of its sections —
//    that's consumption, posted as Food Cost / Inventory.
router.post('/stock-out', requireAnyPermission('can_manage_inventory', 'can_transfer_stock'), async (req: Request, res: Response) => {
  const body = stockOutSchema.parse(req.body)
  const orgId = req.user.organizationId

  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: orgId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  // A store keeper sends stock out of their own store only; the destination
  // of a branch transfer can be any branch.
  await assertBranchAccess(req, body.branchId)

  let toBranch: { id: string; name: string } | null = null
  let section: { id: string; name: string } | null = null
  if (body.type === 'branch_transfer') {
    if (body.toBranchId === body.branchId) throw new AppError('Destination branch must be different from the source branch', 400, 'VALIDATION_ERROR')
    toBranch = await prisma.branch.findFirst({ where: { id: body.toBranchId, organizationId: orgId }, select: { id: true, name: true } })
    if (!toBranch) throw new AppError('Destination branch not found', 404, 'NOT_FOUND')
  } else {
    section = await prisma.branchSection.findFirst({
      where: { id: body.sectionId, organizationId: orgId, branchId: body.branchId, isActive: true },
      select: { id: true, name: true },
    })
    if (!section) throw new AppError('Section not found in this branch', 404, 'NOT_FOUND')
  }

  const stockOutDate = body.stockOutDate ? new Date(body.stockOutDate) : new Date()

  const result = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as typeof prisma
    const stockOutNo = await nextNumber(db, 'stockOut', 'stockOutNo', 'SO', orgId)
    const header = await tx.stockOut.create({
      data: {
        organizationId: orgId,
        branchId: body.branchId,
        stockOutNo,
        stockOutDate,
        type: body.type,
        toBranchId: toBranch?.id,
        sectionId: section?.id,
        reason: body.reason,
        notes: body.notes,
        createdBy: req.user.id,
      },
    })

    const destinationLabel = toBranch ? `to ${toBranch.name}` : `to ${section!.name}`
    let totalValue = 0
    for (const line of body.items) {
      const { unitCost, totalValue: lineValue } = await applyStockOut(db, {
        organizationId: orgId,
        branchId: body.branchId,
        itemId: line.itemId,
        quantity: line.quantity,
        movementType: toBranch ? 'transfer_out' : 'stock_out',
        transferBranchId: toBranch?.id,
        sectionId: section?.id,
        referenceType: 'stock_out',
        referenceId: header.id,
        notes: `${stockOutNo} ${destinationLabel}${body.reason ? ` — ${body.reason}` : ''}`,
        createdBy: req.user.id,
      })
      totalValue += lineValue

      if (toBranch) {
        await applyStockIn(db, {
          organizationId: orgId,
          branchId: toBranch.id,
          itemId: line.itemId,
          quantity: line.quantity,
          unitCost,
          movementType: 'transfer_in',
          transferBranchId: body.branchId,
          referenceType: 'stock_out',
          referenceId: header.id,
          notes: `${stockOutNo} from ${branch.name}`,
          createdBy: req.user.id,
        })
      }
    }

    let journalEntryId: string | undefined
    if (section && totalValue > 0) {
      const [costOfSales, inventory] = await Promise.all([
        resolveMappedAccount(db, orgId, 'COST_OF_SALES'),
        resolveMappedAccount(db, orgId, 'INVENTORY'),
      ])
      const je = await postJournalEntry(db, {
        organizationId: orgId,
        branchId: body.branchId,
        entryDate: stockOutDate,
        referenceType: 'stock_out',
        referenceId: header.id,
        sourceType: 'STOCK_OUT',
        sourceKey: `STOCK_OUT:${header.id}:POST`,
        description: `Stock Out ${stockOutNo} — issued to ${section.name}`,
        createdBy: req.user.id,
        lines: [
          { accountId: costOfSales.id, description: `Issued to ${section.name}`, debitAmount: totalValue },
          { accountId: inventory.id, description: 'Inventory reduction (stock out)', creditAmount: totalValue },
        ],
      })
      journalEntryId = je?.id
    }

    return tx.stockOut.update({ where: { id: header.id }, data: { totalValue, journalEntryId } })
  })

  res.status(201).json(result)
})

// GET /inventory/stock-outs?branchId=&type=&sectionId=&toBranchId=&fromDate=&toDate=
// branchId matches either side of a transfer, so a branch sees what it
// sent and what it received.
router.get('/stock-outs', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_view_reports'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, type, sectionId, toBranchId, fromDate, toDate } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const bf = await branchFilter(req, branchId)
  if (bf) where.OR = [{ branchId: bf }, { toBranchId: bf }]
  if (type) where.type = type
  if (sectionId) where.sectionId = sectionId
  if (toBranchId) where.toBranchId = toBranchId
  if (fromDate || toDate) {
    where.stockOutDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(`${toDate}T23:59:59.999`) }),
    }
  }

  const [rows, total] = await Promise.all([
    prisma.stockOut.findMany({
      where,
      ...paginate(page, limit),
      orderBy: [{ stockOutDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        branch: { select: { id: true, name: true } },
        toBranch: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
      },
    }),
    prisma.stockOut.count({ where }),
  ])

  const ids = rows.map((r) => r.id)
  const lineCounts = await prisma.stockMovement.groupBy({
    by: ['referenceId'],
    where: { referenceType: 'stock_out', referenceId: { in: ids }, quantity: { lt: 0 } },
    _count: true,
  })
  const countById = new Map(lineCounts.map((c) => [c.referenceId, c._count]))
  const userIds = [...new Set(rows.map((r) => r.createdBy))]
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
  const userName = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]))

  const data = rows.map((r) => ({
    ...r,
    branchName: r.branch.name,
    toBranchName: r.toBranch?.name,
    sectionName: r.section?.name,
    itemCount: countById.get(r.id) ?? 0,
    createdByName: userName.get(r.createdBy) ?? null,
  }))
  res.json(paginatedResponse(data, total, page, limit))
})

// GET /inventory/stock-outs/:id — header plus its item lines
router.get('/stock-outs/:id', requireAnyPermission('can_manage_inventory', 'can_transfer_stock', 'can_view_reports'), async (req: Request, res: Response) => {
  const stockOut = await prisma.stockOut.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: {
      branch: { select: { id: true, name: true } },
      toBranch: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
  })
  if (!stockOut) throw new AppError('Stock out not found', 404, 'NOT_FOUND')
  const scope = await getBranchScope(req)
  if (scope.restricted && !scope.branchIds.includes(stockOut.branchId) && !(stockOut.toBranchId && scope.branchIds.includes(stockOut.toBranchId))) {
    throw new AppError('You can only access your own branch', 403, 'BRANCH_FORBIDDEN')
  }

  const [lines, user] = await Promise.all([
    prisma.stockMovement.findMany({
      where: { referenceType: 'stock_out', referenceId: stockOut.id, branchId: stockOut.branchId },
      include: { item: { select: { id: true, name: true, code: true, unit: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findUnique({ where: { id: stockOut.createdBy }, select: { firstName: true, lastName: true } }),
  ])

  res.json({
    ...stockOut,
    branchName: stockOut.branch.name,
    toBranchName: stockOut.toBranch?.name,
    sectionName: stockOut.section?.name,
    createdByName: user ? `${user.firstName} ${user.lastName}`.trim() : null,
    items: lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      itemName: l.item.name,
      itemCode: l.item.code,
      unit: l.item.unit,
      quantity: Math.abs(l.quantity),
      unitCost: l.unitCost,
      totalValue: l.totalValue,
    })),
  })
})

const addPurchaseItemSchema = z.object({
  purchaseOrderItemId: z.string(),
  unitCost: z.coerce.number().min(0),
})

const addPurchaseSchema = z.object({
  purchaseOrderId: z.string(),
  supplierId: z.string(),
  purchaseDate: z.string(),
  paymentDate: z.string(),
  totalAmount: z.coerce.number().min(0),
  paidAmount: z.coerce.number().min(0).default(0),
  note: z.string().optional(),
  items: z.string(), // JSON-stringified addPurchaseItemSchema[]
})

// POST /inventory/purchases — receive an approved PO into branch stock, with
// real costing/supplier/payment/invoice captured at the moment of receiving,
// auto-creating the matching Supplier Bill (and Payment, if partly/fully paid).
router.post('/purchases', requireAnyPermission('can_approve_purchase_order'), upload.single('file'), async (req: Request, res: Response) => {
  const body = addPurchaseSchema.parse(req.body)
  let itemInputs: { purchaseOrderItemId: string; unitCost: number }[]
  try {
    itemInputs = z.array(addPurchaseItemSchema).parse(JSON.parse(body.items))
  } catch {
    throw new AppError('Invalid items payload', 400, 'VALIDATION_ERROR')
  }
  if (itemInputs.length === 0) throw new AppError('At least one item is required', 400, 'VALIDATION_ERROR')

  try {
    const bill = await prisma.$transaction(async (tx) => {
      const order = await tx.purchaseOrder.findFirst({
        where: { id: body.purchaseOrderId, organizationId: req.user.organizationId },
        include: { items: true },
      })
      if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
      if (order.status !== 'approved') throw new AppError('Only approved purchase orders can be received', 400, 'INVALID_STATUS')
      await assertBranchAccess(req, order.branchId)

      const supplier = await tx.supplier.findFirst({
        where: { id: body.supplierId, organizationId: req.user.organizationId },
      })
      if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

      const poItemsById = new Map(order.items.map((i) => [i.id, i]))
      const resolvedLines = itemInputs.map((input) => {
        const poItem = poItemsById.get(input.purchaseOrderItemId)
        if (!poItem) throw new AppError('Purchase order item not found on this order', 400, 'VALIDATION_ERROR')
        return { poItem, unitCost: input.unitCost, totalCost: poItem.quantity * input.unitCost }
      })

      for (const line of resolvedLines) {
        await tx.purchaseOrderItem.update({
          where: { id: line.poItem.id },
          data: { unitCost: line.unitCost, totalCost: line.totalCost },
        })
      }

      const subtotal = resolvedLines.reduce((sum, l) => sum + l.totalCost, 0)
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: {
          subtotal,
          totalAmount: subtotal,
          status: 'received',
          receivedBy: req.user.id,
          receivedAt: new Date(),
        },
      })

      const billNo = await nextNumber(tx as unknown as typeof prisma, 'bill', 'billNo', 'BILL', req.user.organizationId)
      const paidAmount = body.paidAmount
      const balanceDue = body.totalAmount - paidAmount
      const status = balanceDue <= 0.01 ? 'paid' : paidAmount > 0 ? 'partial' : 'approved'

      const createdBill = await tx.bill.create({
        data: {
          organizationId: req.user.organizationId,
          branchId: order.branchId,
          supplierId: body.supplierId,
          billNo,
          billDate: new Date(body.purchaseDate),
          dueDate: new Date(body.paymentDate),
          subtotal,
          totalAmount: body.totalAmount,
          paidAmount,
          balanceDue,
          status,
          notes: body.note,
          createdBy: req.user.id,
          items: {
            create: resolvedLines.map((line) => ({
              description: line.poItem.description,
              quantity: line.poItem.quantity,
              unitPrice: line.unitCost,
              totalAmount: line.totalCost,
              itemId: line.poItem.itemId,
            })),
          },
        },
      })

      const [inventoryAccount, payable] = await Promise.all([
        resolveMappedAccount(tx as unknown as typeof prisma, req.user.organizationId, 'INVENTORY'),
        resolveMappedAccount(tx as unknown as typeof prisma, req.user.organizationId, 'ACCOUNTS_PAYABLE'),
      ])

      // Receiving is the effective approval point for a PO-sourced bill (it's
      // created pre-approved, with no separate draft/approval gap) — post now.
      const billJe = await postJournalEntry(tx as unknown as typeof prisma, {
        organizationId: req.user.organizationId,
        branchId: order.branchId,
        entryDate: new Date(body.purchaseDate),
        referenceType: 'bill',
        referenceId: createdBill.id,
        sourceType: 'BILL',
        sourceKey: `BILL:${createdBill.id}:APPROVAL`,
        description: `Supplier Bill ${billNo} (PO ${order.poNo})`,
        createdBy: req.user.id,
        lines: [
          { accountId: inventoryAccount.id, description: 'Stock received', debitAmount: body.totalAmount },
          { accountId: payable.id, description: 'Payable to supplier', creditAmount: body.totalAmount },
        ],
      })
      await tx.bill.update({ where: { id: createdBill.id }, data: { journalEntryId: billJe?.id } })

      if (paidAmount > 0) {
        const payment = await tx.payment.create({
          data: {
            organizationId: req.user.organizationId,
            branchId: order.branchId,
            billId: createdBill.id,
            paymentDate: new Date(body.paymentDate),
            amount: paidAmount,
            paymentMethod: 'cash',
            createdBy: req.user.id,
          },
        })

        const cash = await resolveMappedAccount(tx as unknown as typeof prisma, req.user.organizationId, 'CASH_ON_HAND')

        const paymentJe = await postJournalEntry(tx as unknown as typeof prisma, {
          organizationId: req.user.organizationId,
          branchId: order.branchId,
          entryDate: new Date(body.paymentDate),
          referenceType: 'payment',
          referenceId: payment.id,
          sourceType: 'BILL_PAYMENT',
          sourceKey: `BILL_PAYMENT:${payment.id}:POST`,
          description: `Payment for Bill ${billNo}`,
          createdBy: req.user.id,
          lines: [
            { accountId: payable.id, description: 'Payable settled', debitAmount: paidAmount },
            { accountId: cash.id, description: 'Cash paid to supplier', creditAmount: paidAmount },
          ],
        })
        await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: paymentJe?.id } })
      }

      if (req.file) {
        const document = await tx.document.create({
          data: {
            organizationId: req.user.organizationId,
            branchId: order.branchId,
            originalFilename: req.file.originalname,
            storedFilename: req.file.filename,
            filePath: req.file.path,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            documentType: 'bill',
            linkedType: 'bill',
            linkedId: createdBill.id,
            uploadedBy: req.user.id,
          },
        })
        await tx.bill.update({ where: { id: createdBill.id }, data: { documentId: document.id } })
      }

      for (const line of resolvedLines) {
        if (!line.poItem.itemId) continue // free-text lines aren't linked to a stock item
        await applyStockIn(tx as unknown as typeof prisma, {
          organizationId: req.user.organizationId,
          branchId: order.branchId,
          itemId: line.poItem.itemId,
          quantity: line.poItem.quantity,
          unitCost: line.unitCost,
          referenceType: 'purchase',
          referenceId: createdBill.id,
          notes: `Purchased via PO ${order.poNo}`,
          createdBy: req.user.id,
        })
      }

      return tx.bill.findUniqueOrThrow({
        where: { id: createdBill.id },
        include: { items: true, supplier: true, branch: true },
      })
    })

    res.status(201).json(bill)
  } catch (err) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path) } catch { /* best-effort cleanup */ }
    }
    throw err
  }
})

// GET /inventory/wastage/pending-approval
router.get('/wastage/pending-approval', requireAnyPermission('can_approve_wastage', 'can_view_approvals'), async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'draft' }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf

  const reports = await prisma.wastageReport.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } } },
  })
  res.json({ data: reports })
})

// GET /inventory/wastage
router.get('/wastage', requireAnyPermission('can_manage_inventory', 'can_approve_wastage', 'can_view_approvals', 'can_view_reports'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf

  const [reports, total] = await Promise.all([
    prisma.wastageReport.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { reportDate: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        items: { include: { item: true } },
      },
    }),
    prisma.wastageReport.count({ where }),
  ])

  res.json(paginatedResponse(reports, total, page, limit))
})

// POST /inventory/wastage
router.post('/wastage', requireAnyPermission('can_manage_inventory'), async (req: Request, res: Response) => {
  const body = wastageSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, body.branchId)

  const totalValue = body.items.reduce((sum, i) => sum + i.totalValue, 0)

  const report = await prisma.wastageReport.create({
    data: {
      organizationId: req.user.organizationId,
      branchId: body.branchId,
      reportDate: new Date(body.reportDate),
      totalValue,
      notes: body.notes,
      createdBy: req.user.id,
      items: { create: body.items },
    },
    include: { items: { include: { item: true } }, branch: true },
  })

  res.status(201).json(report)
})

// POST /inventory/wastage/:id/approve
router.post('/wastage/:id/approve', requireAnyPermission('can_approve_wastage'), async (req: Request, res: Response) => {
  const report = await prisma.wastageReport.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true },
  })
  if (!report) throw new AppError('Wastage report not found', 404, 'NOT_FOUND')
  if (report.status !== 'draft') throw new AppError('Report already processed', 400, 'INVALID_STATUS')
  await assertBranchAccess(req, report.branchId)

  // Reduce stock for each item
  for (const wi of report.items) {
    const stock = await prisma.branchStock.findUnique({
      where: { branchId_itemId: { branchId: report.branchId, itemId: wi.itemId } },
    })

    if (stock) {
      const newQty = Math.max(0, stock.quantityOnHand - wi.quantity)
      const newValue = newQty * stock.averageCost
      await prisma.branchStock.update({
        where: { branchId_itemId: { branchId: report.branchId, itemId: wi.itemId } },
        data: { quantityOnHand: newQty, totalValue: newValue, lastUpdated: new Date() },
      })
    }

    // Record movement
    await prisma.stockMovement.create({
      data: {
        organizationId: req.user.organizationId,
        branchId: report.branchId,
        itemId: wi.itemId,
        movementType: 'wastage',
        quantity: -wi.quantity,
        unitCost: wi.unitCost,
        totalValue: wi.totalValue,
        referenceType: 'wastage_report',
        referenceId: report.id,
        createdBy: req.user.id,
      },
    })
  }

  const [wastageExpense, inventory] = await Promise.all([
    resolveMappedAccount(prisma, req.user.organizationId, 'WASTAGE_EXPENSE'),
    resolveMappedAccount(prisma, req.user.organizationId, 'INVENTORY'),
  ])

  const je = await postJournalEntry(prisma, {
    organizationId: req.user.organizationId,
    branchId: report.branchId,
    entryDate: report.reportDate,
    referenceType: 'wastage_report',
    referenceId: report.id,
    sourceType: 'WASTAGE',
    sourceKey: `WASTAGE:${report.id}:APPROVAL`,
    description: `Wastage Report - ${report.id}`,
    createdBy: req.user.id,
    lines: [
      { accountId: wastageExpense.id, description: 'Stock written off as wastage', debitAmount: report.totalValue },
      { accountId: inventory.id, description: 'Inventory reduction (wastage)', creditAmount: report.totalValue },
    ],
  })

  const updated = await prisma.wastageReport.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), journalEntryId: je?.id },
    include: { items: { include: { item: true } }, branch: true },
  })

  res.json(updated)
})

export default router
