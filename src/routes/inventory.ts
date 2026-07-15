import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { applyStockIn } from '../utils/stock'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const itemSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().default('kg'),
  costPrice: z.number().default(0),
  reorderPoint: z.number().default(0),
})

const stockInSchema = z.object({
  branchId: z.string(),
  itemId: z.string(),
  quantity: z.number().positive(),
  unitCost: z.number().default(0),
  notes: z.string().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
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

// GET /inventory/stock
router.get('/stock', async (req: Request, res: Response) => {
  const { branchId, search, lowStock } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId

  const stocks = await prisma.branchStock.findMany({
    where,
    include: {
      item: true,
      branch: { select: { id: true, name: true } },
    },
    orderBy: { item: { name: 'asc' } },
  })

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
    filtered = filtered.filter((st) => st.quantityOnHand <= st.reorderPoint)
  }

  res.json({ data: filtered, total: filtered.length })
})

// GET /inventory/items
router.get('/items', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const search = req.query.search as string | undefined

  const where = {
    organizationId: req.user.organizationId,
    isActive: true,
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
    }),
    prisma.item.count({ where }),
  ])

  res.json(paginatedResponse(items, total, page, limit))
})

// POST /inventory/items
router.post('/items', async (req: Request, res: Response) => {
  const body = itemSchema.parse(req.body)
  const item = await prisma.item.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(item)
})

// GET /inventory/items/:id
router.get('/items/:id', async (req: Request, res: Response) => {
  const item = await prisma.item.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { branchStocks: { include: { branch: true } } },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')
  res.json(item)
})

// PUT /items/:id
router.put('/items/:id', async (req: Request, res: Response) => {
  const item = await prisma.item.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  const body = itemSchema.partial().parse(req.body)
  const updated = await prisma.item.update({ where: { id: req.params.id }, data: body })
  res.json(updated)
})

// DELETE /inventory/items/:id
router.delete('/items/:id', async (req: Request, res: Response) => {
  const item = await prisma.item.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  const hasMovements = await prisma.stockMovement.count({ where: { itemId: req.params.id } })
  if (hasMovements > 0) {
    await prisma.item.update({ where: { id: req.params.id }, data: { isActive: false } })
    return res.json({ message: 'Item deactivated (has stock movements)' })
  }

  await prisma.item.delete({ where: { id: req.params.id } })
  res.json({ message: 'Item deleted' })
})

// POST /inventory/stock-in
router.post('/stock-in', async (req: Request, res: Response) => {
  const body = stockInSchema.parse(req.body)

  const item = await prisma.item.findFirst({
    where: { id: body.itemId, organizationId: req.user.organizationId },
  })
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND')

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const movement = await applyStockIn(prisma, {
    organizationId: req.user.organizationId,
    branchId: body.branchId,
    itemId: body.itemId,
    quantity: body.quantity,
    unitCost: body.unitCost,
    referenceType: body.referenceType,
    referenceId: body.referenceId,
    notes: body.notes,
    createdBy: req.user.id,
  })

  res.status(201).json(movement)
})

// GET /inventory/movements
router.get('/movements', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, itemId, movementType } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (itemId) where.itemId = itemId
  if (movementType) where.movementType = movementType

  const [movements, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { createdAt: 'desc' },
      include: {
        item: { select: { id: true, name: true, code: true, unit: true } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.stockMovement.count({ where }),
  ])

  res.json(paginatedResponse(movements, total, page, limit))
})

// GET /inventory/wastage/pending-approval
router.get('/wastage/pending-approval', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'draft' }
  if (branchId) where.branchId = branchId

  const reports = await prisma.wastageReport.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } } },
  })
  res.json({ data: reports })
})

// GET /inventory/wastage
router.get('/wastage', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId

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
router.post('/wastage', async (req: Request, res: Response) => {
  const body = wastageSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

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
router.post('/wastage/:id/approve', async (req: Request, res: Response) => {
  const report = await prisma.wastageReport.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true },
  })
  if (!report) throw new AppError('Wastage report not found', 404, 'NOT_FOUND')
  if (report.status !== 'draft') throw new AppError('Report already processed', 400, 'INVALID_STATUS')

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

  const updated = await prisma.wastageReport.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
    include: { items: { include: { item: true } }, branch: true },
  })

  res.json(updated)
})

export default router
