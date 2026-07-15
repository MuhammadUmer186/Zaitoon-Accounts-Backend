import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { applyStockIn } from '../utils/stock'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const poItemSchema = z.object({
  itemId: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  vatRate: z.number().default(0),
  vatAmount: z.number().default(0),
  totalCost: z.number(),
})

const poSchema = z.object({
  branchId: z.string(),
  supplierId: z.string(),
  orderDate: z.string().or(z.date()),
  expectedDeliveryDate: z.string().or(z.date()).optional(),
  notes: z.string().optional(),
  documentId: z.string().optional(),
  subtotal: z.number(),
  vatAmount: z.number().default(0),
  totalAmount: z.number(),
  items: z.array(poItemSchema).min(1),
})

const includeRelations = {
  branch: { select: { id: true, name: true, code: true } },
  supplier: { select: { id: true, name: true } },
  items: { include: { item: { select: { id: true, name: true, code: true, unit: true } } } },
}

// GET /purchase-orders
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, supplierId, status, fromDate, toDate } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (supplierId) where.supplierId = supplierId
  if (status) where.status = status
  if (fromDate || toDate) {
    where.orderDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { orderDate: 'desc' },
      include: includeRelations,
    }),
    prisma.purchaseOrder.count({ where }),
  ])

  res.json(paginatedResponse(orders, total, page, limit))
})

// GET /purchase-orders/pending-approval
router.get('/pending-approval', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'submitted' }
  if (branchId) where.branchId = branchId

  const orders = await prisma.purchaseOrder.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    include: includeRelations,
  })
  res.json({ data: orders })
})

// POST /purchase-orders
router.post('/', async (req: Request, res: Response) => {
  const body = poSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const supplier = await prisma.supplier.findFirst({
    where: { id: body.supplierId, organizationId: req.user.organizationId },
  })
  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const poNo = await nextNumber(prisma, 'purchaseOrder', 'poNo', 'PO', req.user.organizationId)
  const { items, ...poData } = body

  const order = await prisma.purchaseOrder.create({
    data: {
      ...poData,
      poNo,
      orderDate: new Date(poData.orderDate),
      expectedDeliveryDate: poData.expectedDeliveryDate ? new Date(poData.expectedDeliveryDate) : undefined,
      organizationId: req.user.organizationId,
      createdBy: req.user.id,
      items: { create: items },
    },
    include: includeRelations,
  })

  res.status(201).json(order)
})

// GET /purchase-orders/:id
router.get('/:id', async (req: Request, res: Response) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: includeRelations,
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  res.json(order)
})

// PUT /purchase-orders/:id
router.put('/:id', async (req: Request, res: Response) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (order.status !== 'draft') throw new AppError('Only draft purchase orders can be edited', 400, 'INVALID_STATUS')

  const body = poSchema.partial().parse(req.body)
  const { items, ...poData } = body

  if (items !== undefined) {
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: req.params.id } })
    if (items.length > 0) {
      await prisma.purchaseOrderItem.createMany({
        data: items.map((i) => ({ ...i, purchaseOrderId: req.params.id })),
      })
    }
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: {
      ...poData,
      ...(poData.orderDate && { orderDate: new Date(poData.orderDate) }),
      ...(poData.expectedDeliveryDate && { expectedDeliveryDate: new Date(poData.expectedDeliveryDate) }),
    },
    include: includeRelations,
  })

  res.json(updated)
})

// POST /purchase-orders/:id/submit
router.post('/:id/submit', async (req: Request, res: Response) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (order.status !== 'draft') throw new AppError('Only draft purchase orders can be submitted', 400, 'INVALID_STATUS')

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() },
  })
  res.json(updated)
})

// POST /purchase-orders/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (order.status !== 'submitted') throw new AppError('Only submitted purchase orders can be approved', 400, 'INVALID_STATUS')

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
  })
  res.json(updated)
})

// POST /purchase-orders/:id/reject
router.post('/:id/reject', async (req: Request, res: Response) => {
  const { rejectionReason } = req.body as Record<string, string>
  if (!rejectionReason) throw new AppError('Rejection reason is required', 400, 'VALIDATION_ERROR')

  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (order.status !== 'submitted') throw new AppError('Only submitted purchase orders can be rejected', 400, 'INVALID_STATUS')

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'rejected', rejectionReason },
  })
  res.json(updated)
})

// POST /purchase-orders/:id/receive — receive an approved PO into branch stock
router.post('/:id/receive', async (req: Request, res: Response) => {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true },
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (order.status !== 'approved') throw new AppError('Only approved purchase orders can be received', 400, 'INVALID_STATUS')

  for (const line of order.items) {
    if (!line.itemId) continue // free-text lines aren't linked to a stock item
    await applyStockIn(prisma, {
      organizationId: req.user.organizationId,
      branchId: order.branchId,
      itemId: line.itemId,
      quantity: line.quantity,
      unitCost: line.unitCost,
      referenceType: 'purchase_order',
      referenceId: order.id,
      notes: `Received from PO ${order.poNo}`,
      createdBy: req.user.id,
    })
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'received', receivedBy: req.user.id, receivedAt: new Date() },
    include: includeRelations,
  })

  res.json(updated)
})

// POST /purchase-orders/:id/void
router.post('/:id/void', async (req: Request, res: Response) => {
  const { voidReason } = req.body as Record<string, string>
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  if (order.status === 'received') throw new AppError('A received purchase order cannot be voided', 400, 'INVALID_STATUS')
  if (order.status === 'void') throw new AppError('Purchase order is already voided', 400, 'INVALID_STATUS')

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  res.json(updated)
})

export default router
