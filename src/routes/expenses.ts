import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { requireAnyPermission } from '../middleware/authorize'
import { upload } from '../middleware/upload'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod, reverseJournalEntry } from '../utils/ledger'

const router = Router()

router.use(authenticate)

const expenseSchema = z.object({
  branchId: z.string(),
  expenseDate: z.string().or(z.date()),
  categoryId: z.string(),
  description: z.string().min(1),
  amount: z.number().positive(),
  vatAmount: z.number().default(0),
  vatRate: z.number().default(0),
  totalAmount: z.number(),
  paymentMethod: z.string().default('cash'),
  supplierId: z.string().optional(),
  notes: z.string().optional(),
})

const categorySchema = z.object({
  name: z.string().min(1),
  accountId: z.string().optional(),
  description: z.string().optional(),
})

// GET /expenses/categories
router.get('/categories', requireAnyPermission('can_create_expense', 'can_approve_expense', 'can_void_expense', 'can_view_approvals', 'can_view_reports', 'can_create_purchasing_entry', 'can_manage_accounting'), async (req: Request, res: Response) => {
  const categories = await prisma.expenseCategory.findMany({
    where: { organizationId: req.user.organizationId, isActive: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: categories })
})

// POST /expenses/categories
router.post('/categories', requireAnyPermission('can_approve_expense', 'can_manage_accounting'), async (req: Request, res: Response) => {
  const body = categorySchema.parse(req.body)
  const category = await prisma.expenseCategory.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(category)
})

// DELETE /expenses/categories/:id
router.delete('/categories/:id', requireAnyPermission('can_approve_expense', 'can_manage_accounting'), async (req: Request, res: Response) => {
  const inUse = await prisma.expense.count({
    where: { categoryId: req.params.id, organizationId: req.user.organizationId },
  })
  if (inUse > 0) throw new AppError(`Cannot delete — ${inUse} expense(s) use this category`, 400, 'IN_USE')

  await prisma.expenseCategory.delete({ where: { id: req.params.id } })
  res.json({ message: 'Category deleted' })
})

// GET /expenses/pending-approval
router.get('/pending-approval', requireAnyPermission('can_approve_expense', 'can_view_approvals'), async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'submitted' }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf

  const expenses = await prisma.expense.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { branch: { select: { id: true, name: true } }, category: true },
  })
  res.json({ data: expenses })
})

// GET /expenses
router.get('/', requireAnyPermission('can_create_expense', 'can_approve_expense', 'can_void_expense', 'can_view_approvals', 'can_view_reports'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, fromDate, toDate, status, categoryId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf
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
router.post('/purchasing-payment', requireAnyPermission('can_create_expense'), upload.single('paymentSlip'), async (req: Request, res: Response) => {
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
      if (!['approved', 'partial'].includes(bill.status)) {
        throw new AppError(`Purchase ${bill.billNo} is not pending payment (status: ${bill.status})`, 400, 'INVALID_STATUS')
      }
      if (!bill.categoryId) throw new AppError('This purchase has no category — it cannot be paid as an expense', 400, 'VALIDATION_ERROR')
      if (body.amount > bill.balanceDue + 0.01) {
        throw new AppError(`Amount exceeds the balance due (${bill.balanceDue.toFixed(2)})`, 400, 'OVERPAYMENT')
      }

      const paymentDate = new Date(body.paymentDate)
      const payment = await tx.payment.create({
        data: {
          organizationId: req.user.organizationId,
          branchId: bill.branchId,
          billId: bill.id,
          paymentDate,
          amount: body.amount,
          paymentMethod: body.paymentMethod,
          referenceNo: body.referenceNo,
          notes: body.notes,
          paidBy: body.paidBy,
          createdBy: req.user.id,
        },
      })

      const [payable, paidFrom] = await Promise.all([
        resolveMappedAccount(db, req.user.organizationId, 'ACCOUNTS_PAYABLE'),
        resolveMappedAccount(db, req.user.organizationId, mappingKeyForPaymentMethod(body.paymentMethod)),
      ])
      const je = await postJournalEntry(db, {
        organizationId: req.user.organizationId,
        branchId: bill.branchId,
        entryDate: paymentDate,
        referenceType: 'payment',
        referenceId: payment.id,
        sourceType: 'BILL_PAYMENT',
        sourceKey: `BILL_PAYMENT:${payment.id}:POST`,
        description: `Payment for Purchase ${bill.billNo} — ${bill.supplier.name}`,
        createdBy: req.user.id,
        lines: [
          { accountId: payable.id, description: 'Payable settled', debitAmount: body.amount },
          { accountId: paidFrom.id, description: `Paid by ${body.paidBy}`, creditAmount: body.amount },
        ],
      })

      let slipDocumentId: string | undefined
      if (slip) {
        const doc = await tx.document.create({
          data: {
            organizationId: req.user.organizationId,
            branchId: bill.branchId,
            originalFilename: slip.originalname,
            storedFilename: slip.filename,
            filePath: slip.path,
            fileType: slip.mimetype,
            fileSize: slip.size,
            documentType: 'payment_slip',
            linkedType: 'payment',
            linkedId: payment.id,
            uploadedBy: req.user.id,
          },
        })
        slipDocumentId = doc.id
      }
      await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: je?.id, documentId: slipDocumentId } })

      const newPaid = bill.paidAmount + body.amount
      const newBalance = Math.max(0, Math.round((bill.totalAmount - newPaid) * 100) / 100)
      await tx.bill.update({
        where: { id: bill.id },
        data: { paidAmount: newPaid, balanceDue: newBalance, status: newBalance <= 0.01 ? 'paid' : 'partial' },
      })

      const expenseNo = await nextNumber(db, 'expense', 'expenseNo', bill.branch.expensePrefix || 'EXP', req.user.organizationId)
      return tx.expense.create({
        data: {
          organizationId: req.user.organizationId,
          branchId: bill.branchId,
          expenseNo,
          expenseDate: paymentDate,
          categoryId: bill.categoryId,
          description: `Payment for Purchase ${bill.billNo} — ${bill.supplier.name}`,
          amount: body.amount,
          vatAmount: 0,
          vatRate: 0,
          totalAmount: body.amount,
          paymentMethod: body.paymentMethod,
          source: 'purchasing',
          billId: bill.id,
          paymentId: payment.id,
          paidBy: body.paidBy,
          supplierId: bill.supplierId,
          receiptDocumentId: slipDocumentId,
          status: 'approved',
          approvedBy: req.user.id,
          approvedAt: new Date(),
          journalEntryId: je?.id,
          notes: body.notes,
          createdBy: req.user.id,
        },
      })
    })
    res.status(201).json(expense)
  } catch (err) {
    cleanup()
    throw err
  }
})

// POST /expenses
router.post('/', requireAnyPermission('can_create_expense'), async (req: Request, res: Response) => {
  const body = expenseSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, branch.id)

  const expenseNo = await nextNumber(
    prisma,
    'expense',
    'expenseNo',
    branch.expensePrefix || 'EXP',
    req.user.organizationId
  )

  const expense = await prisma.expense.create({
    data: {
      ...body,
      expenseNo,
      expenseDate: new Date(body.expenseDate),
      organizationId: req.user.organizationId,
      createdBy: req.user.id,
    },
    include: { branch: true, category: true },
  })

  res.status(201).json(expense)
})

// GET /expenses/:id
router.get('/:id', requireAnyPermission('can_create_expense', 'can_approve_expense', 'can_void_expense', 'can_view_approvals', 'can_view_reports'), async (req: Request, res: Response) => {
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
router.put('/:id', requireAnyPermission('can_create_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be edited', 400, 'INVALID_STATUS')
  if (expense.source === 'purchasing') throw new AppError('Purchasing payments cannot be edited — void and re-enter instead', 400, 'INVALID_STATUS')

  const body = expenseSchema.partial().parse(req.body)

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: {
      ...body,
      ...(body.expenseDate && { expenseDate: new Date(body.expenseDate) }),
    },
    include: { branch: true, category: true },
  })

  res.json(updated)
})

// POST /expenses/:id/submit
router.post('/:id/submit', requireAnyPermission('can_create_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be submitted', 400, 'INVALID_STATUS')

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: { status: 'submitted', submittedBy: req.user.id, submittedAt: new Date() },
  })
  res.json(updated)
})

// POST /expenses/:id/approve
router.post('/:id/approve', requireAnyPermission('can_approve_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { category: true },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'submitted') throw new AppError('Only submitted expenses can be approved', 400, 'INVALID_STATUS')

  const [expenseAccount, inputVat, creditAccount] = await Promise.all([
    expense.category.accountId
      ? prisma.account.findUniqueOrThrow({ where: { id: expense.category.accountId } })
      : resolveMappedAccount(prisma, req.user.organizationId, 'DEFAULT_EXPENSE'),
    expense.vatAmount > 0 ? resolveMappedAccount(prisma, req.user.organizationId, 'INPUT_VAT') : null,
    resolveMappedAccount(prisma, req.user.organizationId, expense.supplierId ? 'ACCOUNTS_PAYABLE' : mappingKeyForPaymentMethod(expense.paymentMethod)),
  ])

  const je = await postJournalEntry(prisma, {
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

  const updated = await prisma.expense.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), journalEntryId: je?.id },
  })
  res.json(updated)
})

// DELETE /expenses/:id (draft only)
router.delete('/:id', requireAnyPermission('can_create_expense'), async (req: Request, res: Response) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!expense) throw new AppError('Expense not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, expense.branchId)
  if (expense.status !== 'draft') throw new AppError('Only draft expenses can be deleted', 400, 'INVALID_STATUS')

  await prisma.expense.delete({ where: { id: req.params.id } })
  res.json({ message: 'Expense deleted' })
})

// POST /expenses/:id/void
router.post('/:id/void', requireAnyPermission('can_void_expense'), async (req: Request, res: Response) => {
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
    if (expense.journalEntryId) {
      await reverseJournalEntry(db, expense.journalEntryId, req.user.id, `Void — ${voidReason}`)
    }

    // A purchasing-mode expense is a bill payment: voiding it must also undo
    // the payment so the purchase shows as pending (balance due) again.
    if (expense.source === 'purchasing' && expense.billId && expense.paymentId) {
      const [bill, payment] = await Promise.all([
        tx.bill.findUnique({ where: { id: expense.billId } }),
        tx.payment.findUnique({ where: { id: expense.paymentId } }),
      ])
      if (bill && payment) {
        const newPaid = Math.max(0, bill.paidAmount - payment.amount)
        const newBalance = Math.round((bill.totalAmount - newPaid) * 100) / 100
        await tx.bill.update({
          where: { id: bill.id },
          data: {
            paidAmount: newPaid,
            balanceDue: newBalance,
            status: bill.status === 'void' ? 'void' : newPaid > 0.01 ? 'partial' : 'approved',
          },
        })
        await tx.payment.delete({ where: { id: payment.id } })
      }
    }

    return tx.expense.update({
      where: { id: req.params.id },
      data: { status: 'void', voidReason },
    })
  })
  res.json(updated)
})

export default router
