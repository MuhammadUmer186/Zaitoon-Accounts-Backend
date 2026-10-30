import { roundMoney } from '../utils/money'
import { logAudit } from '../utils/audit'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { lockPurchasing, recordPurchasePayment } from '../services/purchasePayments'
import { updateSchema } from '../utils/updateSchema'
import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { assertNotOwnSubmission, requireModule, requirePermission, requireAnyPermission } from '../middleware/authorize'
import { upload } from '../middleware/upload'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod, reverseJournalEntry } from '../utils/ledger'

const router = Router()

router.use(authenticate)
router.use(requireModule('expenses', 'purchasing', 'approvals'))

// Numbers and booleans are coerced because the combined New Entry form posts
// expenses as multipart (with an optional receipt), where every field is a string.
const formBoolean = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

const expenseSchema = z.object({
  branchId: z.string(),
  expenseDate: z.string().or(z.date()),
  categoryId: z.string(),
  description: z.string().min(1),
  amount: z.coerce.number().positive(),
  vatAmount: z.coerce.number().default(0),
  vatRate: z.coerce.number().min(0).max(100).default(0),
  totalAmount: z.coerce.number(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'card', 'cheque', 'mada', 'other']).default('cash'),
  supplierId: z.string().optional(),
  notes: z.string().optional(),
  submitForApproval: formBoolean.optional(),
})

// "Maintenance" is picked from the vendor list on the New Entry form. It is
// an operating expense, not a supplier purchase: no bill, no stock, and it is
// reported on its own (source "maintenance"). Without a category it files
// under the organization's Maintenance category, created on first use.
const createExpenseSchema = expenseSchema.extend({
  categoryId: z.string().optional(),
  source: z.enum(['manual', 'maintenance']).default('manual'),
}).refine((b) => b.categoryId || b.source === 'maintenance', { message: 'Category is required', path: ['categoryId'] })

const MAINTENANCE_CATEGORY = 'Maintenance'

const categorySchema = z.object({
  name: z.string().min(1),
  accountId: z.string().optional(),
  description: z.string().optional(),
})

// GET /expenses/categories
router.get('/categories', async (req: Request, res: Response) => {
  const categories = await prisma.expenseCategory.findMany({
    where: { organizationId: req.user.organizationId, isActive: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: categories })
})

// POST /expenses/categories
router.post('/categories', requireAnyPermission('can_create_expense', 'can_approve_expense'), async (req: Request, res: Response) => {
  const body = categorySchema.parse(req.body)
  if (body.accountId && !await prisma.account.count({ where: { id: body.accountId, organizationId: req.user.organizationId, status: 'ACTIVE' } })) throw new AppError('Account not found', 404, 'NOT_FOUND')
  const category = await prisma.expenseCategory.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(category)
})

// DELETE /expenses/categories/:id
router.delete('/categories/:id', requirePermission('can_approve_expense'), async (req: Request, res: Response) => {
  const counts = await Promise.all([prisma.expense.count({ where: { categoryId: req.params.id, organizationId: req.user.organizationId } }), prisma.bill.count({ where: { categoryId: req.params.id, organizationId: req.user.organizationId } })])
  const inUse = counts[0] + counts[1]
  if (inUse > 0) throw new AppError(`Cannot delete — ${inUse} purchase(s) or expense(s) use this category`, 400, 'IN_USE')

  const deleted = await prisma.expenseCategory.deleteMany({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!deleted.count) throw new AppError('Category not found', 404, 'NOT_FOUND')
  res.json({ message: 'Category deleted' })
})

// GET /expenses/pending-approval
router.get('/pending-approval', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'submitted' }
  const scopedBranch = await branchFilter(req, branchId)
  if (scopedBranch) where.branchId = scopedBranch

  const expenses = await prisma.expense.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } }, category: true },
  })
  res.json({ data: expenses })
})

// GET /expenses
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, fromDate, toDate, status, categoryId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const scopedBranch = await branchFilter(req, branchId)
  if (scopedBranch) where.branchId = scopedBranch
  if (status) where.status = status
  if (categoryId) where.categoryId = categoryId
  if (fromDate || toDate) {
    where.expenseDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const { source } = req.query as Record<string, string>
  if (source) where.source = source
  if (typeof req.query.billId === 'string') where.billId = req.query.billId

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { expenseDate: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        category: true,
      },
    }),
    prisma.expense.count({ where }),
  ])

  const rows = expenses.map((e) => ({ ...e, branchName: e.branch?.name, categoryName: e.category?.name }))
  res.json(paginatedResponse(rows, total, page, limit))
})

const purchasingPaymentSchema = z.object({
  billId: z.string(),
  requestId: z.string().uuid().optional(),
  paymentDate: z.string(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'card', 'cheque']),
  amount: z.coerce.number().positive(),
  paidBy: z.string().trim().min(1, 'Paid By is required'),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
})

// POST /expenses/purchasing-payment — the "Purchasing" mode of New Expense:
// pays (fully or partially) a pending Purchasing bill. Posts the payment
// journal entry (Accounts Payable → Cash/Bank) exactly like a bill payment,
// and records a matching Expense row (source "purchasing") so the payment is
// visible in the Expenses module. The Expense reuses the payment's journal
// entry rather than posting its own — the purchase cost was already booked
// when the bill was created, so a second posting would double count it.
router.post('/purchasing-payment', requireAnyPermission('can_create_expense', 'can_make_payment', 'can_create_purchasing_entry'), upload.single('paymentSlip'), async (req: Request, res: Response) => {
  const slip = req.file
  const cleanup = () => { if (slip) { try { fs.unlinkSync(slip.path) } catch { /* best-effort cleanup */ } } }

  const parsed = purchasingPaymentSchema.safeParse(req.body)
  if (!parsed.success) { cleanup(); throw parsed.error }
  const body = parsed.data
  if (body.paymentMethod === 'bank_transfer' && !slip) {
    throw new AppError('A transfer slip attachment is required for bank transfer payments', 400, 'VALIDATION_ERROR')
  }

  try {
    const expense = await prisma.$transaction(async (tx) => {
      const db = tx as unknown as typeof prisma
      const bill = await tx.bill.findFirst({
        where: { id: body.billId, organizationId: req.user.organizationId, source: 'purchasing' },
        include: { supplier: true, branch: true },
      })
      if (!bill) throw new AppError('Purchase not found', 404, 'NOT_FOUND')
      await assertBranchAccess(req, bill.branchId)
      let documentId: string | undefined
      if (slip) {
        const doc = await tx.document.create({ data: {
          organizationId: req.user.organizationId, branchId: bill.branchId,
          originalFilename: slip.originalname, storedFilename: slip.filename, filePath: slip.path,
          fileType: slip.mimetype, fileSize: slip.size, documentType: 'payment_slip',
          uploadedBy: req.user.id,
        } })
        documentId = doc.id
      }
      const result = await recordPurchasePayment(db, {
        ...body, organizationId: req.user.organizationId, createdBy: req.user.id,
        paymentDate: new Date(body.paymentDate), documentId,
      })
      if (documentId && result.payment.documentId !== documentId) { await tx.document.delete({ where: { id: documentId } }); cleanup() }
      else if (documentId) await tx.document.update({ where: { id: documentId }, data: { linkedType: 'payment', linkedId: result.payment.id } })
      await logAudit(db, { req, action: 'purchase.payment_recorded', module: 'expenses', resourceType: 'payment', resourceId: result.payment.id, branchId: bill.branchId, newData: { billId: bill.id, amount: body.amount } })
      return result.expense
    })
    res.status(201).json(expense)
  } catch (err) {
    cleanup()
    throw err
  }
})

// POST /expenses — JSON, or multipart with an optional `receipt` attachment
router.post('/', requirePermission('can_create_expense'), upload.single('receipt'), async (req: Request, res: Response) => {
  const receipt = req.file
  const cleanup = () => { if (receipt) { try { fs.unlinkSync(receipt.path) } catch { /* best-effort cleanup */ } } }
  try {
    const expense = await createExpense(req, receipt)
    res.status(201).json(expense)
  } catch (err) {
    cleanup()
    throw err
  }
})

async function createExpense(req: Request, receipt?: Express.Multer.File) {
  const body = createExpenseSchema.parse(req.body)
  body.amount = roundMoney(body.amount)
  body.vatAmount = roundMoney(body.amount * body.vatRate / 100)
  body.totalAmount = roundMoney(body.amount + body.vatAmount)
  if (body.amount <= 0 || !Number.isFinite(new Date(body.expenseDate).getTime())) throw new AppError('Invalid amount or expense date', 400, 'VALIDATION_ERROR')
  // A maintenance entry is paid on the spot; a supplier would turn it into an
  // unpaid payable that nothing on the purchase side can settle.
  if (body.source === 'maintenance') body.supplierId = undefined

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, branch.id)
  if (body.categoryId && !await prisma.expenseCategory.count({ where: { id: body.categoryId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Category not found', 404, 'NOT_FOUND')

  if (body.supplierId && !await prisma.supplier.count({ where: { id: body.supplierId, organizationId: req.user.organizationId } })) throw new AppError('Supplier not found', 404, 'NOT_FOUND')
  const { submitForApproval, categoryId, ...expenseData } = body
  return prisma.$transaction(async tx => {
    const db = tx as unknown as typeof prisma
    await lockPurchasing(db, req.user.organizationId)
    const resolvedCategoryId = categoryId ?? (await tx.expenseCategory.upsert({
      where: { organizationId_name: { organizationId: req.user.organizationId, name: MAINTENANCE_CATEGORY } },
      update: { isActive: true },
      create: { organizationId: req.user.organizationId, name: MAINTENANCE_CATEGORY, description: 'Repairs and upkeep — operating expense' },
    })).id
    const expenseNo = await nextNumber(
      db,
      'expense',
      'expenseNo',
      branch.expensePrefix || 'EXP',
      req.user.organizationId
    )
    const document = receipt ? await tx.document.create({ data: {
      organizationId: req.user.organizationId, branchId: branch.id, originalFilename: receipt.originalname,
      storedFilename: receipt.filename, filePath: receipt.path, fileType: receipt.mimetype,
      fileSize: receipt.size, documentType: 'receipt', uploadedBy: req.user.id,
    } }) : null

    const created = await tx.expense.create({
      data: {
        ...expenseData,
        categoryId: resolvedCategoryId,
        receiptDocumentId: document?.id,
        ...(submitForApproval && { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() }),
        expenseNo,
        expenseDate: new Date(body.expenseDate),
        organizationId: req.user.organizationId,
        createdBy: req.user.id,
      },
      include: { branch: true, category: true },
    })
    if (document) await tx.document.update({ where: { id: document.id }, data: { linkedType: 'expense', linkedId: created.id } })

    await logAudit(db, { req, action: submitForApproval ? 'expense.submitted' : 'expense.created', module: 'expenses', resourceType: 'expense', resourceId: created.id, branchId: created.branchId, newData: { totalAmount: created.totalAmount, source: created.source } })
    return created
  })
}

// GET /expenses/:id
router.get('/:id', async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { branch: true, category: true },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)

  // Purchasing-mode expenses carry the paid bill (with its attachment) and
  // the payment's transfer slip, so the detail page can show both.
  let bill = null
  if (expense.billId) {
    const b = await prisma.bill.findUnique({
      where: { id: expense.billId },
      include: { items: true, supplier: { select: { id: true, name: true, vatNumber: true, city: true } } },
    })
    if (b) {
      const document = b.documentId
        ? await prisma.document.findUnique({ where: { id: b.documentId }, select: { id: true, originalFilename: true, fileType: true } })
        : null
      bill = { ...b, supplierName: b.supplier.name, document }
    }
  }
  const receiptDocument = expense.receiptDocumentId
    ? await prisma.document.findUnique({ where: { id: expense.receiptDocumentId }, select: { id: true, originalFilename: true, fileType: true } })
    : null

  res.json({
    ...expense,
    branchName: expense.branch?.name,
    categoryName: expense.category?.name,
    bill,
    receiptDocument,
  })
})

// PUT /expenses/:id
router.put('/:id', requirePermission('can_create_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be edited', 400, 'INVALID_STATUS')
  if (expense.source === 'purchasing') throw new AppError('Purchasing payments cannot be edited — void and re-enter instead', 400, 'INVALID_STATUS')

  const { submitForApproval: _submit, ...body } = updateSchema(expenseSchema).parse(req.body)
  if (body.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: req.user.organizationId } })
    if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
    await assertBranchAccess(req, branch.id)
  }
  if (body.categoryId && !await prisma.expenseCategory.count({ where: { id: body.categoryId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Category not found', 404, 'NOT_FOUND')
  if (body.supplierId && !await prisma.supplier.count({ where: { id: body.supplierId, organizationId: req.user.organizationId } })) throw new AppError('Supplier not found', 404, 'NOT_FOUND')
  if (body.expenseDate && !Number.isFinite(new Date(body.expenseDate).getTime())) throw new AppError('Invalid date', 400, 'VALIDATION_ERROR')
  const amount = roundMoney(body.amount ?? expense.amount)
  if (amount <= 0) throw new AppError('Expense amount must be positive', 400, 'VALIDATION_ERROR')
  const vatRate = body.vatRate ?? expense.vatRate
  const vatAmount = roundMoney(amount * vatRate / 100)
  Object.assign(body, { amount, vatRate, vatAmount, totalAmount: roundMoney(amount + vatAmount) })


  const changed = await prisma.expense.updateMany({
    where: { id: expense.id, organizationId: req.user.organizationId, status: 'draft' },
    data: { ...body, ...(body.expenseDate && { expenseDate: new Date(body.expenseDate) }) },
  })
  if (!changed.count) throw new AppError('Expense is no longer a draft', 409, 'INVALID_STATUS')
  const updated = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id }, include: { branch: true, category: true } })

  res.json(updated)
})

// POST /expenses/:id/submit
router.post('/:id/submit', requirePermission('can_create_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be submitted', 400, 'INVALID_STATUS')

  const changed = await prisma.expense.updateMany({ where: { id: expense.id, organizationId: req.user.organizationId, status: 'draft' }, data: { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() } })
  if (!changed.count) throw new AppError('Expense is no longer a draft', 409, 'INVALID_STATUS')
  res.json(await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } }))
})

// POST /expenses/:id/approve
router.post('/:id/approve', requirePermission('can_approve_expense'), async (req: Request, res: Response) => {
  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as typeof prisma
    await lockPurchasing(db, req.user.organizationId)
    const expense = await tx.expense.findFirst({
      where: { id: req.params.id, organizationId: req.user.organizationId },
      include: { category: true },
    })
    if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
    await assertBranchAccess(req, expense.branchId)
    if (expense.status !== 'submitted') throw new AppError('Only submitted expenses can be approved', 400, 'INVALID_STATUS')
    await assertNotOwnSubmission(req, expense.createdBy, 'expense')

    const [expenseAccount, inputVat, creditAccount] = await Promise.all([
      expense.category.accountId
        ? tx.account.findUniqueOrThrow({ where: { id: expense.category.accountId } })
        : resolveMappedAccount(db, req.user.organizationId, 'DEFAULT_EXPENSE'),
      expense.vatAmount > 0 ? resolveMappedAccount(db, req.user.organizationId, 'INPUT_VAT') : null,
      resolveMappedAccount(db, req.user.organizationId, expense.supplierId ? 'ACCOUNTS_PAYABLE' : mappingKeyForPaymentMethod(expense.paymentMethod)),
    ])

    const je = await postJournalEntry(db, {
      organizationId: req.user.organizationId,
      branchId: expense.branchId,
      entryDate: expense.expenseDate,
      referenceType: 'expense',
      referenceId: expense.id,
      sourceType: 'EXPENSE',
      sourceKey: `EXPENSE:${expense.id}:APPROVAL`,
      description: `Expense - ${expense.expenseNo} (${expense.description})`,
      createdBy: req.user.id,
      lines: [
        { accountId: expenseAccount.id, description: expense.description, debitAmount: expense.amount },
        ...(inputVat ? [{ accountId: inputVat.id, description: 'Input VAT', debitAmount: expense.vatAmount }] : []),
        { accountId: creditAccount.id, description: 'Payment / payable for expense', creditAmount: expense.totalAmount },
      ],
    })

    return tx.expense.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), journalEntryId: je?.id },
    })
  })
  res.json(updated)
})

// DELETE /expenses/:id (draft only)
router.delete('/:id', requirePermission('can_create_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be deleted', 400, 'INVALID_STATUS')

  const deleted = await prisma.expense.deleteMany({ where: { id: expense.id, organizationId: req.user.organizationId, status: 'draft' } })
  if (!deleted.count) throw new AppError('Expense is no longer a draft', 409, 'INVALID_STATUS')
  res.json({ message: 'Expense deleted' })
})

// POST /expenses/:id/void
router.post('/:id/void', requirePermission('can_void_expense'), async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status === 'void') throw new AppError('Expense is already voided', 400, 'INVALID_STATUS')

  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as typeof prisma
    await lockPurchasing(db, req.user.organizationId)
    const current = await tx.expense.findUniqueOrThrow({ where: { id: expense.id } })
    if (current.status === 'void') throw new AppError('Expense is already voided', 400, 'INVALID_STATUS')
    if (expense.billId) await tx.$queryRaw`SELECT id FROM "Bill" WHERE id = ${expense.billId} FOR UPDATE`
    if (current.journalEntryId) {
      await reverseJournalEntry(db, current.journalEntryId, req.user.id, `Void — ${voidReason}`)
    }

    // A purchasing-mode expense is a bill payment: voiding it must also undo
    // the payment so the purchase shows as pending (balance due) again.
    if (expense.source === 'purchasing' && expense.billId && expense.paymentId) {
      const [bill, payment] = await Promise.all([
        tx.bill.findUnique({ where: { id: expense.billId } }),
        tx.payment.findUnique({ where: { id: expense.paymentId } }),
      ])
      if (bill && payment) {
        const newPaid = Math.max(0, roundMoney(bill.paidAmount - payment.amount))
        const newBalance = roundMoney(bill.totalAmount - newPaid)
        await tx.bill.update({
          where: { id: bill.id },
          data: {
            paidAmount: newPaid,
            balanceDue: newBalance,
            status: bill.status === 'void' ? 'void' : newPaid > 0 ? 'partial' : 'approved',
          },
        })
        // Keep the payment and its document for audit history. The linked
        // void expense marks it as reversed in the register and bill detail.
      }
    }

    const voided = await tx.expense.update({ where: { id: req.params.id }, data: { status: 'void', voidReason } })
    await logAudit(db, { req, action: 'expense.voided', module: 'expenses', resourceType: 'expense', resourceId: expense.id, branchId: expense.branchId, newData: { voidReason, billId: expense.billId, paymentId: expense.paymentId } })
    return voided
  })
  res.json(updated)
})

export default router
