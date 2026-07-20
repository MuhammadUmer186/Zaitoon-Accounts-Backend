import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { upload } from '../middleware/upload'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { applyStockIn } from '../utils/stock'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

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

  const where: Record<string, unknown> = { organizationId: req.user.organizationId, quantityOnHand: { gt: 0 } }
  if (branchId) where.branchId = branchId

  const stocks = await prisma.branchStock.findMany({
    where,
    include: {
      item: true,
      branch: { select: { id: true, name: true } },
    },
    orderBy: [{ branch: { name: 'asc' } }, { item: { name: 'asc' } }],
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
    isLowStock: st.quantityOnHand <= st.reorderPoint,
    lastUpdated: st.lastUpdated,
  }))

  res.json({ data, total: data.length })
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
router.post('/purchases', upload.single('file'), async (req: Request, res: Response) => {
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

      if (paidAmount > 0) {
        await tx.payment.create({
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
