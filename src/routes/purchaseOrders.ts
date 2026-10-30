import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireModule, requirePermission } from '../middleware/authorize'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { Prisma } from '@prisma/client'
import { assertBranchAccess, branchFilter, getBranchScope } from '../utils/branchScope'

const router = Router()

router.use(authenticate)
router.use(requireModule('purchase_orders', 'approvals'))
// Resolve the request's cached scope before opening a transaction. Otherwise
// a busy pool can be exhausted by transactions waiting for scope queries that
// need another connection from that same pool.
router.use(async (req: Request, _res: Response, next: NextFunction) => {
  await getBranchScope(req)
  next()
})

// Super admins can turn the multi-step PO workflow off org-wide (Settings >
// Modules) once the simpler Purchasing module covers their needs. Existing
// POs remain viewable (GET routes are unaffected) — only new activity is blocked.
async function requirePurchaseOrdersEnabled(req: Request, res: Response, next: NextFunction) {
  const org = await prisma.organization.findUnique({ where: { id: req.user.organizationId } })
  if (!org?.purchaseOrderEnabled) {
    throw new AppError('The Purchase Order system is disabled for this organization', 403, 'PURCHASE_ORDERS_DISABLED')
  }
  next()
}

const poItemSchema = z.object({
  itemId: z.string().min(1).optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
})

const poSchema = z.object({
  branchId: z.string().min(1),
  orderDate: z.string().refine(v => Number.isFinite(Date.parse(v)), 'Invalid order date').or(z.date()),
  expectedDeliveryDate: z.string().refine(v => Number.isFinite(Date.parse(v)), 'Invalid delivery date').or(z.date()).optional(),
  notes: z.string().optional(),
  items: z.array(poItemSchema).min(1),
})

const includeRelations = {
  branch: { select: { id: true, name: true, code: true } },
  items: { include: { item: { select: { id: true, name: true, code: true, unit: true } } } },
}

async function validateReferences(tx: Prisma.TransactionClient, req: Request, branchId: string, items?: { itemId?: string }[]) {
  await assertBranchAccess(req, branchId)
  if (!await tx.branch.count({ where: { id: branchId, organizationId: req.user.organizationId } })) {
    throw new AppError('Branch not found', 404, 'NOT_FOUND')
  }
  const ids = [...new Set(items?.flatMap(i => i.itemId ? [i.itemId] : []) ?? [])]
  if (ids.length && await tx.item.count({ where: { id: { in: ids }, organizationId: req.user.organizationId } }) !== ids.length) {
    throw new AppError('One or more inventory items were not found', 400, 'INVALID_ITEM')
  }
}

// Every edit and transition takes the same lock, then re-reads the state.
// An edit that waited for approval must not use an earlier draft snapshot.
async function lockedOrder(tx: Prisma.TransactionClient, req: Request) {
  await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${req.params.id} AND "organizationId" = ${req.user.organizationId} FOR UPDATE`
  const order = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!order) throw new AppError('Purchase order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  return order
}

// GET /purchase-orders
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, status, fromDate, toDate } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const allowed = await branchFilter(req, branchId)
  if (allowed) where.branchId = allowed
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
  const allowed = await branchFilter(req, branchId)
  if (allowed) where.branchId = allowed

  const orders = await prisma.purchaseOrder.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    include: includeRelations,
  })
  res.json({ data: orders })
})

// POST /purchase-orders
router.post('/', requirePermission('can_create_purchase_order'), requirePurchaseOrdersEnabled, async (req: Request, res: Response) => {
  const body = poSchema.parse(req.body)

  const { items, ...poData } = body
  const order = await prisma.$transaction(async tx => {
    await validateReferences(tx, req, body.branchId, items)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchase-order-number:${req.user.organizationId}`}))`
    const poNo = await nextNumber(tx, 'purchaseOrder', 'poNo', 'PO', req.user.organizationId)
    return tx.purchaseOrder.create({
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
  await assertBranchAccess(req, order.branchId)
  res.json(order)
})

// PUT /purchase-orders/:id
router.put('/:id', requirePermission('can_create_purchase_order'), requirePurchaseOrdersEnabled, async (req: Request, res: Response) => {
  const body = updateSchema(poSchema).parse(req.body)
  const { items, ...poData } = body
  const updated = await prisma.$transaction(async tx => {
    const order = await lockedOrder(tx, req)
    if (order.status !== 'draft') throw new AppError('Only draft purchase orders can be edited', 400, 'INVALID_STATUS')
    await validateReferences(tx, req, poData.branchId ?? order.branchId, items)
    if (items !== undefined) {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: req.params.id } })
      if (items.length > 0) {
        await tx.purchaseOrderItem.createMany({
          data: items.map((i) => ({ ...i, purchaseOrderId: req.params.id })),
        })
      }
    }

    return tx.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        ...poData,
        ...(poData.orderDate && { orderDate: new Date(poData.orderDate) }),
        ...(poData.expectedDeliveryDate && { expectedDeliveryDate: new Date(poData.expectedDeliveryDate) }),
      },
      include: includeRelations,
    })
  })

  res.json(updated)
})

// POST /purchase-orders/:id/submit
router.post('/:id/submit', requirePermission('can_create_purchase_order'), requirePurchaseOrdersEnabled, async (req: Request, res: Response) => {
  const updated = await prisma.$transaction(async tx => {
    const order = await lockedOrder(tx, req)
    if (order.status !== 'draft') throw new AppError('Only draft purchase orders can be submitted', 400, 'INVALID_STATUS')

    return tx.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() },
    })
  })
  res.json(updated)
})

// POST /purchase-orders/:id/approve
router.post('/:id/approve', requirePermission('can_approve_purchase_order'), requirePurchaseOrdersEnabled, async (req: Request, res: Response) => {
  const updated = await prisma.$transaction(async tx => {
    const order = await lockedOrder(tx, req)
    if (order.status !== 'submitted') throw new AppError('Only submitted purchase orders can be approved', 400, 'INVALID_STATUS')

    return tx.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
    })
  })
  res.json(updated)
})

// POST /purchase-orders/:id/reject
router.post('/:id/reject', requirePermission('can_approve_purchase_order'), requirePurchaseOrdersEnabled, async (req: Request, res: Response) => {
  const { rejectionReason } = req.body as Record<string, string>
  if (!rejectionReason) throw new AppError('Rejection reason is required', 400, 'VALIDATION_ERROR')

  const updated = await prisma.$transaction(async tx => {
    const order = await lockedOrder(tx, req)
    if (order.status !== 'submitted') throw new AppError('Only submitted purchase orders can be rejected', 400, 'INVALID_STATUS')

    return tx.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectionReason },
    })
  })
  res.json(updated)
})

// POST /purchase-orders/:id/void
router.post('/:id/void', requirePermission('can_approve_purchase_order'), async (req: Request, res: Response) => {
  const { voidReason } = req.body as Record<string, string>
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const updated = await prisma.$transaction(async tx => {
    const order = await lockedOrder(tx, req)
    if (order.status === 'received') throw new AppError('A received purchase order cannot be voided', 400, 'INVALID_STATUS')
    if (order.status === 'void') throw new AppError('Purchase order is already voided', 400, 'INVALID_STATUS')

    return tx.purchaseOrder.update({
      where: { id: req.params.id },
      data: { status: 'void', voidReason },
    })
  })
  res.json(updated)
})

export default router
