import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { upload } from '../middleware/upload'
import { AppError } from '../middleware/error'
import { createPurchaseBill, PurchaseItemInput } from '../services/purchasing'
import { parseImportFile, sendImportTemplate } from '../utils/importFile'
import { logAudit } from '../utils/audit'

const router = Router()

router.use(authenticate)

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

const purchaseItemSchema = z.object({
  itemId: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.coerce.number().min(0),
})

const createPurchaseSchema = z
  .object({
    branchId: z.string(),
    supplierId: z.string().optional(),
    vendorName: z.string().optional(),
    vendorCity: z.string().optional(),
    vendorVatNumber: z.string().optional(),
    supplyDate: z.string(),
    paymentDate: z.string(),
    paymentType: z.enum(['cash', 'bank_transfer']),
    vatPercent: z.coerce.number().min(0).max(100),
    amountPaid: z.coerce.number().min(0).optional(),
    items: z.string(), // JSON-stringified purchaseItemSchema[]
  })
  .refine((b) => b.supplierId || b.vendorName, {
    message: 'Either supplierId or vendorName is required',
    path: ['vendorName'],
  })

// POST /purchasing — one-shot vendor purchase entry: creates/uses a Supplier,
// posts the Bill approval journal entry, optionally records payment (full or
// partial), attaches the reference bill / payment slip, and updates branch
// stock for any catalog-linked line — all in a single transaction. This is
// the "Purchasing" module's only endpoint; listing/detail reuse the existing
// /suppliers/bills* routes filtered by source=purchasing.
router.post(
  '/',
  requirePermission('can_create_purchasing_entry'),
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'paymentSlip', maxCount: 1 }]),
  async (req: Request, res: Response) => {
    const body = createPurchaseSchema.parse(req.body)
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    const billFile = files?.file?.[0]
    const paymentSlipFile = files?.paymentSlip?.[0]

    let itemInputs: z.infer<typeof purchaseItemSchema>[]
    try {
      itemInputs = z.array(purchaseItemSchema).parse(JSON.parse(body.items))
    } catch {
      throw new AppError('Invalid items payload', 400, 'VALIDATION_ERROR')
    }
    if (itemInputs.length === 0) throw new AppError('At least one purchased product is required', 400, 'VALIDATION_ERROR')

    const subtotal = itemInputs.reduce((sum, i) => sum + i.quantity * i.unitCost, 0)
    const vatAmount = Math.round(subtotal * (body.vatPercent / 100) * 100) / 100
    const totalAmount = subtotal + vatAmount
    // Not paid unless the user explicitly enters an amount — a purchase
    // shouldn't silently post as fully paid just because Amount Paid was left blank.
    const paidAmount = body.amountPaid ?? 0
    if (paidAmount > totalAmount + 0.01) throw new AppError('Amount paid cannot exceed total payment', 400, 'VALIDATION_ERROR')
    if (body.paymentType === 'bank_transfer' && paidAmount > 0 && !paymentSlipFile) {
      throw new AppError('A transfer slip attachment is required for online transfer payments', 400, 'VALIDATION_ERROR')
    }

    const cleanupFiles = () => {
      for (const f of [billFile, paymentSlipFile]) {
        if (f) { try { fs.unlinkSync(f.path) } catch { /* best-effort cleanup */ } }
      }
    }

    try {
      const bill = await prisma.$transaction(async (tx) => {
        const branch = await tx.branch.findFirst({
          where: { id: body.branchId, organizationId: req.user.organizationId },
        })
        if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

        let supplier
        if (body.supplierId) {
          supplier = await tx.supplier.findFirst({
            where: { id: body.supplierId, organizationId: req.user.organizationId },
          })
          if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')
        } else {
          supplier = await tx.supplier.create({
            data: {
              organizationId: req.user.organizationId,
              name: body.vendorName!,
              vatNumber: body.vendorVatNumber,
              city: body.vendorCity,
            },
          })
        }

        const supplyDate = new Date(body.supplyDate)
        const paymentDate = new Date(body.paymentDate)

        const { bill: createdBill, payment: createdPayment } = await createPurchaseBill(tx as unknown as typeof prisma, {
          organizationId: req.user.organizationId,
          branchId: body.branchId,
          supplierId: supplier.id,
          supplierName: supplier.name,
          supplyDate,
          paymentDate,
          paymentType: body.paymentType,
          vatPercent: body.vatPercent,
          amountPaid: paidAmount,
          items: itemInputs,
          createdBy: req.user.id,
        })

        if (billFile) {
          const document = await tx.document.create({
            data: {
              organizationId: req.user.organizationId,
              branchId: body.branchId,
              originalFilename: billFile.originalname,
              storedFilename: billFile.filename,
              filePath: billFile.path,
              fileType: billFile.mimetype,
              fileSize: billFile.size,
              documentType: 'bill',
              linkedType: 'bill',
              linkedId: createdBill.id,
              uploadedBy: req.user.id,
            },
          })
          await tx.bill.update({ where: { id: createdBill.id }, data: { documentId: document.id } })
        }

        if (paymentSlipFile && createdPayment) {
          const document = await tx.document.create({
            data: {
              organizationId: req.user.organizationId,
              branchId: body.branchId,
              originalFilename: paymentSlipFile.originalname,
              storedFilename: paymentSlipFile.filename,
              filePath: paymentSlipFile.path,
              fileType: paymentSlipFile.mimetype,
              fileSize: paymentSlipFile.size,
              documentType: 'payment_slip',
              linkedType: 'payment',
              linkedId: createdPayment.id,
              uploadedBy: req.user.id,
            },
          })
          await tx.payment.update({ where: { id: createdPayment.id }, data: { documentId: document.id } })
        }

        return tx.bill.findUniqueOrThrow({
          where: { id: createdBill.id },
          include: { items: true, payments: true, supplier: true, branch: true },
        })
      })

      res.status(201).json(bill)
    } catch (err) {
      cleanupFiles()
      throw err
    }
  }
)

// ── Bulk import (CSV/Excel) ─────────────────────────────────────────────────
// Each row is one purchase with a single line item — the common shape for a
// bulk vendor purchase list. supplierName is matched case-insensitively
// against existing suppliers in the org; if no match is found a new Supplier
// is created (mirroring the manual entry form's vendorName behavior). Every
// other supplier is left untouched.
const IMPORT_COLUMNS = ['branchName', 'supplierName', 'supplyDate', 'paymentDate', 'paymentType', 'itemCode', 'itemDescription', 'quantity', 'unitCost', 'vatPercent', 'amountPaid']

router.get('/import/template', requirePermission('can_create_purchasing_entry'), async (req: Request, res: Response) => {
  sendImportTemplate(res, IMPORT_COLUMNS, 'purchasing-import-template')
})

interface PurchaseImportRowResult {
  row: number
  data: Record<string, string>
  errors: string[]
  willCreateSupplier: boolean
}

async function validatePurchaseImportRows(organizationId: string, rows: Record<string, string>[]): Promise<PurchaseImportRowResult[]> {
  const [branches, suppliers, items] = await Promise.all([
    prisma.branch.findMany({ where: { organizationId }, select: { name: true } }),
    prisma.supplier.findMany({ where: { organizationId }, select: { name: true } }),
    prisma.item.findMany({ where: { organizationId }, select: { code: true } }),
  ])
  const branchNames = new Set(branches.map((b) => b.name.toLowerCase()))
  const supplierNames = new Set(suppliers.map((s) => s.name.toLowerCase()))
  const itemCodes = new Set(items.map((i) => i.code.toLowerCase()))
  const newSupplierNamesSeen = new Set<string>()

  return rows.map((data, i) => {
    const errors: string[] = []

    const branchName = data.branchName?.trim()
    if (!branchName) errors.push('branchName is required')
    else if (!branchNames.has(branchName.toLowerCase())) errors.push(`branch "${branchName}" was not found`)

    const supplierName = data.supplierName?.trim()
    if (!supplierName) errors.push('supplierName is required')

    const supplyDate = data.supplyDate?.trim()
    if (!supplyDate || isNaN(Date.parse(supplyDate))) errors.push('supplyDate is required and must be a valid date (YYYY-MM-DD)')

    const paymentDate = data.paymentDate?.trim()
    if (paymentDate && isNaN(Date.parse(paymentDate))) errors.push('paymentDate must be a valid date (YYYY-MM-DD)')

    const paymentType = data.paymentType?.trim().toLowerCase() || 'cash'
    if (!['cash', 'bank_transfer'].includes(paymentType)) errors.push('paymentType must be "cash" or "bank_transfer"')

    const itemDescription = data.itemDescription?.trim()
    if (!itemDescription) errors.push('itemDescription is required')

    const quantity = Number(data.quantity)
    if (!data.quantity?.trim() || !(quantity > 0)) errors.push('quantity must be a positive number')

    const unitCost = Number(data.unitCost)
    if (!data.unitCost?.trim() || isNaN(unitCost) || unitCost < 0) errors.push('unitCost must be a non-negative number')

    const vatPercent = data.vatPercent?.trim() ? Number(data.vatPercent) : 0
    if (isNaN(vatPercent) || vatPercent < 0 || vatPercent > 100) errors.push('vatPercent must be between 0 and 100')

    const amountPaid = data.amountPaid?.trim() ? Number(data.amountPaid) : 0
    if (isNaN(amountPaid) || amountPaid < 0) errors.push('amountPaid must be a non-negative number')

    const itemCode = data.itemCode?.trim()
    if (itemCode && !itemCodes.has(itemCode.toLowerCase())) errors.push(`itemCode "${itemCode}" was not found in the item catalog`)

    if (errors.length === 0) {
      const total = Math.round(quantity * unitCost * (1 + vatPercent / 100) * 100) / 100
      if (amountPaid > total + 0.01) errors.push('amountPaid cannot exceed the purchase total')
    }

    const willCreateSupplier = !!supplierName && !supplierNames.has(supplierName.toLowerCase()) && !newSupplierNamesSeen.has(supplierName.toLowerCase())
    if (supplierName && !supplierNames.has(supplierName.toLowerCase())) newSupplierNamesSeen.add(supplierName.toLowerCase())

    return { row: i + 2, data, errors, willCreateSupplier }
  })
}

router.post('/import/validate', requirePermission('can_create_purchasing_entry'), memoryUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('A CSV or Excel file is required', 400, 'VALIDATION_ERROR')
  const rows = await parseImportFile(req.file)
  const results = await validatePurchaseImportRows(req.user.organizationId, rows)
  res.json({
    totalRows: results.length,
    validRows: results.filter((r) => r.errors.length === 0).length,
    invalidRows: results.filter((r) => r.errors.length > 0).length,
    newSuppliers: [...new Set(results.filter((r) => r.willCreateSupplier).map((r) => r.data.supplierName.trim()))],
    rows: results,
  })
})

router.post('/import/commit', requirePermission('can_create_purchasing_entry'), memoryUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('A CSV or Excel file is required', 400, 'VALIDATION_ERROR')
  const orgId = req.user.organizationId
  const rows = await parseImportFile(req.file)
  const results = await validatePurchaseImportRows(orgId, rows)

  if (results.some((r) => r.errors.length > 0)) {
    throw new AppError('Import contains invalid rows — fix them or re-validate before committing', 400, 'INVALID_IMPORT')
  }
  if (results.length === 0) throw new AppError('No rows to import', 400, 'VALIDATION_ERROR')

  const created = await prisma.$transaction(async (tx) => {
    const [branches, items] = await Promise.all([
      tx.branch.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } }),
      tx.item.findMany({ where: { organizationId: orgId }, select: { id: true, code: true } }),
    ])
    const branchIdByName = new Map(branches.map((b) => [b.name.toLowerCase(), b.id]))
    const itemIdByCode = new Map(items.map((it) => [it.code.toLowerCase(), it.id]))
    const supplierCache = new Map<string, { id: string; name: string }>()

    const bills = []
    // Sequential on purpose — createPurchaseBill allocates bill/journal-entry
    // numbers by counting existing rows, so parallel creates within the same
    // transaction could race and collide on the same number.
    for (const r of results) {
      const supplierNameTrimmed = r.data.supplierName.trim()
      const supplierKey = supplierNameTrimmed.toLowerCase()
      let supplier = supplierCache.get(supplierKey)
      if (!supplier) {
        const existing = await tx.supplier.findFirst({
          where: { organizationId: orgId, name: { equals: supplierNameTrimmed, mode: 'insensitive' } },
        })
        supplier = existing ?? (await tx.supplier.create({ data: { organizationId: orgId, name: supplierNameTrimmed } }))
        supplierCache.set(supplierKey, supplier)
      }

      const branchId = branchIdByName.get(r.data.branchName.trim().toLowerCase())!
      const itemCode = r.data.itemCode?.trim()
      const itemId = itemCode ? itemIdByCode.get(itemCode.toLowerCase()) : undefined
      const supplyDate = new Date(r.data.supplyDate.trim())
      const paymentDateStr = r.data.paymentDate?.trim()
      const paymentDate = paymentDateStr ? new Date(paymentDateStr) : supplyDate
      const paymentType = (r.data.paymentType?.trim().toLowerCase() || 'cash') as 'cash' | 'bank_transfer'
      const vatPercent = r.data.vatPercent?.trim() ? Number(r.data.vatPercent) : 0
      const amountPaid = r.data.amountPaid?.trim() ? Number(r.data.amountPaid) : 0
      const items_: PurchaseItemInput[] = [{
        itemId,
        description: r.data.itemDescription.trim(),
        quantity: Number(r.data.quantity),
        unitCost: Number(r.data.unitCost),
      }]

      const { bill } = await createPurchaseBill(tx as unknown as typeof prisma, {
        organizationId: orgId,
        branchId,
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplyDate,
        paymentDate,
        paymentType,
        vatPercent,
        amountPaid,
        items: items_,
        createdBy: req.user.id,
      })
      bills.push(bill)
    }
    return bills
  }, { maxWait: 10000, timeout: 120000 })

  await logAudit(prisma, { req, action: 'purchasing.imported', module: 'purchasing', resourceType: 'purchasing_import', newData: { count: created.length } })

  res.status(201).json({ imported: created.length })
})

export default router
