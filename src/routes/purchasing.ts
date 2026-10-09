import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { upload, fileFilter } from '../middleware/upload'
import { AppError } from '../middleware/error'
import { createPurchaseBill, PurchaseItemInput } from '../services/purchasing'
import { extractBill, isBillExtractionEnabled } from '../services/billExtraction'
import { parseImportFile, sendImportTemplate, assertRecognizedColumns } from '../utils/importFile'
import { logAudit } from '../utils/audit'
import { assertBranchAccess, getBranchScope, BranchScope } from '../utils/branchScope'

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
    categoryId: z.string().min(1, 'Category is required'),
    supplyDate: z.string(),
    vatPercent: z.coerce.number().min(0).max(100),
    items: z.string(), // JSON-stringified purchaseItemSchema[]
  })
  .refine((b) => b.supplierId || b.vendorName, {
    message: 'Either supplierId or vendorName is required',
    path: ['vendorName'],
  })

// POST /purchasing — one-shot vendor purchase entry: creates/uses a Supplier,
// posts the Bill approval journal entry (as an unpaid payable), attaches the
// mandatory reference bill, and updates branch stock for any catalog-linked
// line — all in a single transaction. No payment is taken here: it's recorded
// later from Expenses → New Expense → Purchasing, which settles the bill
// fully or partially (see expenses.ts /purchasing-payment).
router.post(
  '/',
  requirePermission('can_create_purchasing_entry'),
  upload.fields([{ name: 'file', maxCount: 1 }]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    const billFile = files?.file?.[0]
    const cleanupFiles = () => {
      if (billFile) { try { fs.unlinkSync(billFile.path) } catch { /* best-effort cleanup */ } }
    }

    const parsed = createPurchaseSchema.safeParse(req.body)
    if (!parsed.success) {
      cleanupFiles()
      throw parsed.error
    }
    const body = parsed.data
    if (!billFile) throw new AppError('Attaching the reference bill (PDF/JPG/PNG) is required', 400, 'VALIDATION_ERROR')

    let itemInputs: z.infer<typeof purchaseItemSchema>[]
    try {
      itemInputs = z.array(purchaseItemSchema).parse(JSON.parse(body.items))
    } catch {
      cleanupFiles()
      throw new AppError('Invalid items payload', 400, 'VALIDATION_ERROR')
    }
    if (itemInputs.length === 0) {
      cleanupFiles()
      throw new AppError('At least one purchased product is required', 400, 'VALIDATION_ERROR')
    }

    try {
      const bill = await prisma.$transaction(async (tx) => {
        const branch = await tx.branch.findFirst({
          where: { id: body.branchId, organizationId: req.user.organizationId },
        })
        if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
        await assertBranchAccess(req, body.branchId)

        const category = await tx.expenseCategory.findFirst({
          where: { id: body.categoryId, organizationId: req.user.organizationId },
        })
        if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND')

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

        const { bill: createdBill } = await createPurchaseBill(tx as unknown as typeof prisma, {
          organizationId: req.user.organizationId,
          branchId: body.branchId,
          supplierId: supplier.id,
          supplierName: supplier.name,
          categoryId: category.id,
          supplyDate,
          paymentDate: supplyDate,
          paymentType: 'cash',
          vatPercent: body.vatPercent,
          amountPaid: 0,
          items: itemInputs,
          createdBy: req.user.id,
        })

        {
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

        return tx.bill.findUniqueOrThrow({
          where: { id: createdBill.id },
          include: { items: true, payments: true, supplier: true, branch: true, category: true },
        })
      })

      res.status(201).json(bill)
    } catch (err) {
      cleanupFiles()
      throw err
    }
  }
)

// ── Scan bill (auto-fill) ───────────────────────────────────────────────────
// Reads an uploaded bill and returns a draft purchase for the New Purchase
// form to pre-fill. Nothing is stored — the file is kept in memory only; the
// form re-uploads it as the mandatory attachment when the user hits Apply.
const extractUpload = multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: 10 * 1024 * 1024 } })

router.get('/extract/status', requirePermission('can_create_purchasing_entry'), async (_req: Request, res: Response) => {
  res.json({ enabled: isBillExtractionEnabled() })
})

router.post('/extract', requirePermission('can_create_purchasing_entry'), extractUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('Upload the bill as a PDF, JPG or PNG', 400, 'VALIDATION_ERROR')
  const result = await extractBill(req.user.organizationId, req.file)
  res.json(result)
})

// ── Bulk import (CSV/Excel) ─────────────────────────────────────────────────
// Each row is one purchase with a single line item — the common shape for a
// bulk vendor purchase list. supplierName and itemCode are both matched
// case-insensitively against existing records; when either doesn't match, a
// new Supplier / Item is created (mirroring the manual entry form's
// vendorName behavior). Anything that does match is reused untouched — an
// import never edits an existing supplier or item.
const IMPORT_COLUMNS = ['branchName', 'supplierName', 'categoryName', 'supplyDate', 'paymentDate', 'paymentType', 'itemCode', 'itemDescription', 'itemUnit', 'quantity', 'unitCost', 'vatPercent', 'amountPaid']

router.get('/import/template', requirePermission('can_create_purchasing_entry'), async (req: Request, res: Response) => {
  sendImportTemplate(res, IMPORT_COLUMNS, 'purchasing-import-template')
})

// Accepts the manual entry form's own vocabulary ("Online Transfer") plus
// common human variants, not just the literal stored value "bank_transfer" —
// spreadsheets get typed by hand, not selected from the form's dropdown.
function normalizePaymentType(raw: string | undefined): 'cash' | 'bank_transfer' | null {
  const v = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!v || v === 'cash') return 'cash'
  const bankTransferSynonyms = new Set([
    'bank_transfer', 'banktransfer', 'bank', 'online_transfer', 'onlinetransfer', 'online', 'transfer', 'wire_transfer', 'wiretransfer',
  ])
  return bankTransferSynonyms.has(v) ? 'bank_transfer' : null
}

interface PurchaseImportRowResult {
  row: number
  data: Record<string, string>
  errors: string[]
  willCreateSupplier: boolean
  willCreateItem: boolean
}

async function validatePurchaseImportRows(organizationId: string, rows: Record<string, string>[], scope?: BranchScope): Promise<PurchaseImportRowResult[]> {
  const [branches, suppliers, items, categories] = await Promise.all([
    prisma.branch.findMany({ where: { organizationId }, select: { id: true, name: true } }),
    prisma.supplier.findMany({ where: { organizationId }, select: { name: true } }),
    prisma.item.findMany({ where: { organizationId }, select: { code: true } }),
    prisma.expenseCategory.findMany({ where: { organizationId, isActive: true }, select: { name: true } }),
  ])
  const categoryNames = new Set(categories.map((c) => c.name.toLowerCase()))
  const branchNames = new Set(branches.map((b) => b.name.toLowerCase()))
  // Store keepers may only import into their own branch
  const forbiddenBranchNames = new Set(
    scope?.restricted ? branches.filter((b) => !scope.branchIds.includes(b.id)).map((b) => b.name.toLowerCase()) : []
  )
  const supplierNames = new Set(suppliers.map((s) => s.name.toLowerCase()))
  const itemCodes = new Set(items.map((i) => i.code.toLowerCase()))
  const newSupplierNamesSeen = new Set<string>()
  const newItemCodesSeen = new Set<string>()

  return rows.map((data, i) => {
    const errors: string[] = []

    const branchName = data.branchName?.trim()
    if (!branchName) errors.push('branchName is required')
    else if (!branchNames.has(branchName.toLowerCase())) errors.push(`branch "${branchName}" was not found`)
    else if (forbiddenBranchNames.has(branchName.toLowerCase())) errors.push(`branch "${branchName}" is not your branch — you can only import into your own branch`)

    const supplierName = data.supplierName?.trim()
    if (!supplierName) errors.push('supplierName is required')

    const categoryName = data.categoryName?.trim()
    if (categoryName && !categoryNames.has(categoryName.toLowerCase())) errors.push(`expense category "${categoryName}" was not found`)

    const supplyDate = data.supplyDate?.trim()
    if (!supplyDate || isNaN(Date.parse(supplyDate))) errors.push('supplyDate is required and must be a valid date (YYYY-MM-DD)')

    const paymentDate = data.paymentDate?.trim()
    if (paymentDate && isNaN(Date.parse(paymentDate))) errors.push('paymentDate must be a valid date (YYYY-MM-DD)')

    if (normalizePaymentType(data.paymentType) === null) {
      errors.push(`paymentType "${data.paymentType}" is not recognized — use "cash" or "bank_transfer" (also accepts "Online Transfer")`)
    }

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

    if (errors.length === 0) {
      const total = Math.round(quantity * unitCost * (1 + vatPercent / 100) * 100) / 100
      if (amountPaid > total + 0.01) errors.push('amountPaid cannot exceed the purchase total')
    }

    const supplierKey = supplierName?.toLowerCase()
    const willCreateSupplier = !!supplierKey && !supplierNames.has(supplierKey) && !newSupplierNamesSeen.has(supplierKey)
    if (supplierKey && !supplierNames.has(supplierKey)) newSupplierNamesSeen.add(supplierKey)

    const itemCode = data.itemCode?.trim()
    const itemKey = itemCode?.toLowerCase()
    const willCreateItem = !!itemKey && !itemCodes.has(itemKey) && !newItemCodesSeen.has(itemKey)
    if (itemKey && !itemCodes.has(itemKey)) newItemCodesSeen.add(itemKey)

    return { row: i + 2, data, errors, willCreateSupplier, willCreateItem }
  })
}

router.post('/import/validate', requirePermission('can_create_purchasing_entry'), memoryUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('A CSV or Excel file is required', 400, 'VALIDATION_ERROR')
  const rows = await parseImportFile(req.file)
  assertRecognizedColumns(rows, IMPORT_COLUMNS)
  const results = await validatePurchaseImportRows(req.user.organizationId, rows, await getBranchScope(req))
  res.json({
    totalRows: results.length,
    validRows: results.filter((r) => r.errors.length === 0).length,
    invalidRows: results.filter((r) => r.errors.length > 0).length,
    newSuppliers: [...new Set(results.filter((r) => r.willCreateSupplier).map((r) => r.data.supplierName.trim()))],
    newItems: [...new Set(results.filter((r) => r.willCreateItem).map((r) => r.data.itemCode.trim()))],
    rows: results,
  })
})

router.post('/import/commit', requirePermission('can_create_purchasing_entry'), memoryUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('A CSV or Excel file is required', 400, 'VALIDATION_ERROR')
  const orgId = req.user.organizationId
  const rows = await parseImportFile(req.file)
  assertRecognizedColumns(rows, IMPORT_COLUMNS)
  const results = await validatePurchaseImportRows(orgId, rows, await getBranchScope(req))

  if (results.some((r) => r.errors.length > 0)) {
    throw new AppError('Import contains invalid rows — fix them or re-validate before committing', 400, 'INVALID_IMPORT')
  }
  if (results.length === 0) throw new AppError('No rows to import', 400, 'VALIDATION_ERROR')

  const created = await prisma.$transaction(async (tx) => {
    const branches = await tx.branch.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } })
    const branchIdByName = new Map(branches.map((b) => [b.name.toLowerCase(), b.id]))
    const categories = await tx.expenseCategory.findMany({ where: { organizationId: orgId, isActive: true }, select: { id: true, name: true } })
    const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]))
    const supplierCache = new Map<string, { id: string; name: string }>()
    const itemCache = new Map<string, { id: string }>()

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
      const itemCodeTrimmed = r.data.itemCode?.trim()
      let itemId: string | undefined
      if (itemCodeTrimmed) {
        const itemKey = itemCodeTrimmed.toLowerCase()
        let item = itemCache.get(itemKey)
        if (!item) {
          const existingItem = await tx.item.findFirst({
            where: { organizationId: orgId, code: { equals: itemCodeTrimmed, mode: 'insensitive' } },
          })
          item = existingItem ?? (await tx.item.create({
            data: {
              organizationId: orgId,
              code: itemCodeTrimmed,
              name: r.data.itemDescription.trim(),
              unit: r.data.itemUnit?.trim() || 'kg',
              costPrice: Number(r.data.unitCost),
            },
          }))
          itemCache.set(itemKey, item)
        }
        itemId = item.id
      }
      const supplyDate = new Date(r.data.supplyDate.trim())
      const paymentDateStr = r.data.paymentDate?.trim()
      const paymentDate = paymentDateStr ? new Date(paymentDateStr) : supplyDate
      const paymentType = normalizePaymentType(r.data.paymentType) ?? 'cash'
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
        categoryId: r.data.categoryName?.trim() ? categoryIdByName.get(r.data.categoryName.trim().toLowerCase()) : undefined,
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
