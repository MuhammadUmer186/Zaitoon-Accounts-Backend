import { roundMoney, moneyTolerance } from '../utils/money'
import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireModule, requirePermission, requireAnyPermission } from '../middleware/authorize'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { financeTransaction, financeLock } from '../utils/financeTransaction'
import { logAudit } from '../utils/audit'
import { validateBillAmounts } from '../services/billAmounts'
import { applyStockIn } from '../utils/stock'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod, reverseJournalEntry } from '../utils/ledger'

const router = Router()

router.use(authenticate)
router.use(requireModule('suppliers', 'bills', 'expenses', 'purchasing', 'inventory', 'purchase_orders', 'approvals'))

const supplierSchema = z.object({
  name: z.string().min(1),
  tradeName: z.string().optional(),
  vatNumber: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  creditLimit: z.number().default(0),
  paymentTermsDays: z.number().default(30),
  notes: z.string().optional(),
})

const billSchema = z.object({
  branchId: z.string(),
  supplierId: z.string(),
  supplierBillNo: z.string().optional(),
  billDate: z.string().or(z.date()),
  dueDate: z.string().or(z.date()),
  subtotal: z.number(),
  discountAmount: z.number().default(0),
  vatAmount: z.number().default(0),
  totalAmount: z.number(),
  items: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
    vatRate: z.number().default(0),
    vatAmount: z.number().default(0),
    totalAmount: z.number(),
    itemId: z.string().optional(),
    accountId: z.string().optional(),
  })).optional(),
})

const paymentSchema = z.object({
  paymentDate: z.string().or(z.date()),
  amount: z.number().positive(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'bank', 'cheque', 'card']),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
})

// GET /suppliers
router.get('/', requireAnyPermission('can_manage_suppliers', 'can_create_bill', 'can_approve_bill', 'can_make_payment', 'can_create_purchasing_entry', 'can_create_purchase_order', 'can_approve_purchase_order', 'can_create_expense', 'can_approve_expense', 'can_view_reports'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const search = req.query.search as string | undefined

  const where = {
    organizationId: req.user.organizationId,
    isActive: true,
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { tradeName: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
  }

  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { name: 'asc' },
    }),
    prisma.supplier.count({ where }),
  ])

  res.json(paginatedResponse(suppliers, total, page, limit))
})

// POST /suppliers
router.post('/', requireAnyPermission('can_manage_suppliers', 'can_create_bill', 'can_create_expense', 'can_create_purchasing_entry'), async (req: Request, res: Response) => {
  const body = supplierSchema.parse(req.body)
  const supplier = await prisma.supplier.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(supplier)
})

// NOTE: all literal /bills* routes must be registered before the generic
// GET/PUT/DELETE /:id routes below — otherwise Express matches them against
// `:id` first (e.g. "/bills" would look up a supplier with id "bills").

// GET /bills/pending-approval
router.get('/bills/pending-approval', requireAnyPermission('can_approve_bill', 'can_view_approvals'), async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'draft' }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf

  const bills = await prisma.bill.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      supplier: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
  })
  res.json({ data: bills.map((b) => ({ ...b, supplierName: b.supplier?.name, branchName: b.branch?.name })) })
})

// GET /bills
router.get('/bills', requireAnyPermission('can_manage_suppliers', 'can_create_bill', 'can_approve_bill', 'can_make_payment', 'can_create_purchasing_entry', 'can_create_expense', 'can_approve_expense', 'can_view_approvals', 'can_view_reports'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, supplierId, status, source, categoryId, search, billNo, fromDate, toDate } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const bf = await branchFilter(req, branchId)
  if (bf) where.branchId = bf
  if (supplierId) where.supplierId = supplierId
  // Comma-separated list allowed, e.g. status=approved,partial for "pending" bills
  if (status) where.status = status.includes(',') ? { in: status.split(',') } : status
  if (source) where.source = source
  if (categoryId) where.categoryId = categoryId
  // Purchase-number-only filter (search below also matches vendor names)
  if (billNo) where.billNo = { contains: billNo.trim(), mode: 'insensitive' }
  if (search) {
    where.OR = [
      { billNo: { contains: search, mode: 'insensitive' } },
      { supplier: { name: { contains: search, mode: 'insensitive' } } },
    ]
  }
  if (fromDate || toDate) {
    where.billDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [bills, total] = await Promise.all([
    prisma.bill.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { billDate: 'desc' },
      include: {
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        _count: { select: { items: true, payments: true } },
      },
    }),
    prisma.bill.count({ where }),
  ])

  const rows = bills.map((b) => ({ ...b, supplierName: b.supplier?.name, branchName: b.branch?.name, categoryName: b.category?.name }))
  res.json(paginatedResponse(rows, total, page, limit))
})

// POST /bills
router.post('/bills', requireAnyPermission('can_create_bill', 'can_manage_suppliers'), async (req: Request, res: Response) => {
  const body = billSchema.parse(req.body)
  const bill = await financeTransaction(prisma, async (tx) => {
  validateBillAmounts(body)

  const branch = await tx.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, branch.id)
  const supplier = await tx.supplier.findFirst({ where: { id: body.supplierId, organizationId: req.user.organizationId } })
  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  if (body.supplierBillNo?.trim()) {
    await financeLock(tx, `vendor-invoice:${req.user.organizationId}:${body.supplierId}`)
    const duplicate = await tx.bill.findFirst({ where: { organizationId: req.user.organizationId, supplierId: body.supplierId, supplierBillNo: { equals: body.supplierBillNo.trim(), mode: 'insensitive' }, status: { not: 'void' } } })
    if (duplicate) throw new AppError('This supplier invoice has already been entered', 400, 'DUPLICATE_VENDOR_INVOICE')
  }
  const billNo = await nextNumber(tx, 'bill', 'billNo', 'BILL', req.user.organizationId)
  const balanceDue = body.totalAmount

  const { items, ...billData } = body

  // No journal posting here — a draft bill has no financial impact yet.
  // Posting happens at /bills/:id/approve, the authoritative posting point.
  const result = await tx.bill.create({
    data: {
      ...billData,
      billNo,
      billDate: new Date(billData.billDate),
      dueDate: new Date(billData.dueDate),
      balanceDue,
      organizationId: req.user.organizationId,
      createdBy: req.user.id,
      items: items && items.length > 0 ? { create: items } : undefined,
    },
    include: { items: true, supplier: true, branch: true },
  })

  await logAudit(tx, { req, action: 'bill.created', module: 'purchasing', resourceType: 'bill', resourceId: result.id })
  return result
  })
  res.status(201).json(bill)
})

// GET /bills/:id
router.get('/bills/:id', requireAnyPermission('can_manage_suppliers', 'can_create_bill', 'can_approve_bill', 'can_make_payment', 'can_create_purchasing_entry', 'can_create_expense', 'can_approve_expense', 'can_view_approvals', 'can_view_reports'), async (req: Request, res: Response) => {
  const bill = await prisma.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true, payments: { orderBy: { paymentDate: 'asc' } }, supplier: true, branch: true, category: true },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, bill.branchId)
  const paymentReceipts = await prisma.expense.findMany({ where: { organizationId: req.user.organizationId, billId: bill.id, source: 'purchasing' }, select: { id: true, paymentId: true, status: true } })
  const reversedPaymentIds = new Set(paymentReceipts.filter(e => e.status === 'void').map(e => e.paymentId))
  const document = bill.documentId
    ? await prisma.document.findUnique({ where: { id: bill.documentId }, select: { id: true, originalFilename: true, fileType: true } })
    : null
  res.json({
    ...bill,
    paymentReceipts,
    payments: bill.payments.map(p => ({ ...p, status: reversedPaymentIds.has(p.id) ? 'void' : 'posted' })),
    supplierName: bill.supplier?.name,
    branchName: bill.branch?.name,
    categoryName: bill.category?.name,
    document,
  })
})

// PUT /bills/:id
router.put('/bills/:id', requireAnyPermission('can_create_bill', 'can_manage_suppliers'), async (req: Request, res: Response) => {
  const updated = await financeTransaction(prisma, async (tx) => {
  await financeLock(tx, `bill:${req.user.organizationId}:${req.params.id}`)
  const bill = await tx.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, bill.branchId)
  if (bill.status !== 'draft') throw new AppError('Only draft bills can be edited', 400, 'INVALID_STATUS')

  const body = updateSchema(billSchema).parse(req.body)
  const merged = { ...bill, ...body }
  validateBillAmounts(merged)
  const branch = await tx.branch.findFirst({ where: { id: merged.branchId, organizationId: req.user.organizationId } })
  const supplier = await tx.supplier.findFirst({ where: { id: merged.supplierId, organizationId: req.user.organizationId } })
  if (!branch || !supplier) throw new AppError('Branch or supplier not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, branch.id)
  if (merged.supplierBillNo?.trim()) {
    await financeLock(tx, `vendor-invoice:${req.user.organizationId}:${merged.supplierId}`)
    const duplicate = await tx.bill.findFirst({ where: { organizationId: req.user.organizationId, supplierId: merged.supplierId, supplierBillNo: { equals: merged.supplierBillNo.trim(), mode: 'insensitive' }, status: { not: 'void' }, id: { not: bill.id } } })
    if (duplicate) throw new AppError('This supplier invoice has already been entered', 400, 'DUPLICATE_VENDOR_INVOICE')
  }
  const { items, ...billData } = body

  const result = await tx.bill.update({
    where: { id: req.params.id },
    data: {
      ...billData,
      balanceDue: merged.totalAmount,
      ...(items && { items: { deleteMany: {}, create: items } }),
      ...(billData.billDate && { billDate: new Date(billData.billDate) }),
      ...(billData.dueDate && { dueDate: new Date(billData.dueDate) }),
    },
    include: { items: true, payments: true, supplier: true, branch: true },
  })

  await logAudit(tx, { req, action: 'bill.updated', module: 'purchasing', resourceType: 'bill', resourceId: bill.id })
  return result
  })
  res.json(updated)
})

// POST /bills/:id/approve — the authoritative financial posting point for a
// manually-created bill (PO-received bills post at receiving time instead —
// see inventory.ts /purchases — since that path has no separate draft phase).
router.post('/bills/:id/approve', requireAnyPermission('can_approve_bill'), async (req: Request, res: Response) => {
  const updated = await financeTransaction(prisma, async (tx) => {
  await financeLock(tx, `bill:${req.user.organizationId}:${req.params.id}`)
  const bill = await tx.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, bill.branchId)
  if (bill.status !== 'draft') throw new AppError('Only draft bills can be approved', 400, 'INVALID_STATUS')

  const billLines = validateBillAmounts(bill)
  const netAmount = bill.totalAmount - bill.vatAmount
  const debitLines: { accountId: string; description: string; debitAmount: number }[] = []
  for (const line of billLines) {
    const accountId = line.accountId ?? (await resolveMappedAccount(tx, req.user.organizationId, line.itemId ? 'INVENTORY' : 'DEFAULT_EXPENSE')).id
    debitLines.push({ accountId, description: line.description, debitAmount: line.netAmount })
  }
  if (!debitLines.length) debitLines.push({ accountId: (await resolveMappedAccount(tx, req.user.organizationId, 'DEFAULT_EXPENSE')).id, description: 'Bill items', debitAmount: netAmount })
  const [inputVat, payable] = await Promise.all([
    bill.vatAmount > 0 ? resolveMappedAccount(tx, req.user.organizationId, 'INPUT_VAT') : null,
    resolveMappedAccount(tx, req.user.organizationId, 'ACCOUNTS_PAYABLE'),
  ])

  const je = await postJournalEntry(tx, {
    organizationId: req.user.organizationId,
    branchId: bill.branchId,
    entryDate: bill.billDate,
    referenceType: 'bill',
    referenceId: bill.id,
    sourceType: 'BILL',
    sourceKey: `BILL:${bill.id}:APPROVAL`,
    description: `Supplier Bill ${bill.billNo}`,
    createdBy: req.user.id,
    lines: [
      ...debitLines,
      ...(inputVat ? [{ accountId: inputVat.id, description: 'Input VAT', debitAmount: bill.vatAmount }] : []),
      { accountId: payable.id, description: 'Payable to supplier', creditAmount: bill.totalAmount },
    ],
  })

  for (const line of billLines) {
    if (!line.itemId) continue
    await applyStockIn(tx, { organizationId: req.user.organizationId, branchId: bill.branchId, itemId: line.itemId, quantity: line.quantity, unitCost: line.netAmount / line.quantity, referenceType: 'bill', referenceId: bill.id, createdBy: req.user.id })
  }

  const result = await tx.bill.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), journalEntryId: je?.id },
    include: { items: true, payments: true, supplier: true, branch: true },
  })
  await logAudit(tx, { req, action: 'bill.approved', module: 'purchasing', resourceType: 'bill', resourceId: bill.id })
  return result
  })
  res.json(updated)
})

// POST /bills/:id/void
router.post('/bills/:id/void', requirePermission('can_approve_bill'), async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const updated = await financeTransaction(prisma, async (tx) => {
  await financeLock(tx, `bill:${req.user.organizationId}:${req.params.id}`)
  const bill = await tx.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, bill.branchId)
  if (bill.status === 'void') throw new AppError('Bill is already voided', 400, 'INVALID_STATUS')
  if (bill.source === 'purchasing') throw new AppError('Purchases with stock movements must be corrected through a purchase return; reverse payments from Purchases & Expenses first', 400, 'PURCHASE_RETURN_REQUIRED')

  const payments = await tx.payment.count({ where: { billId: bill.id } })
  const movements = await tx.stockMovement.count({ where: { organizationId: req.user.organizationId, referenceId: bill.id } })
  if (bill.paidAmount > 0 || payments > 0 || movements > 0) throw new AppError('Paid or stocked purchases require a credit note, return or refund; they cannot be voided directly', 400, 'PURCHASE_RETURN_REQUIRED')

  if (bill.journalEntryId) {
    await reverseJournalEntry(tx, bill.journalEntryId, req.user.id, `Void — ${voidReason}`, req.user.organizationId)
  }

  const result = await tx.bill.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  await logAudit(tx, { req, action: 'bill.voided', module: 'purchasing', resourceType: 'bill', resourceId: bill.id })
  return result
  })
  res.json(updated)
})

// POST /bills/:id/payments
router.post('/bills/:id/payments', requirePermission('can_make_payment'), async (req: Request, res: Response) => {
  const body = paymentSchema.parse(req.body)

  const result = await financeTransaction(prisma, async (tx) => {
  await financeLock(tx, `bill:${req.user.organizationId}:${req.params.id}`)
  const bill = await tx.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, bill.branchId)
  if (!['approved', 'partial'].includes(bill.status)) throw new AppError('Only approved bills with an outstanding balance can be paid', 400, 'INVALID_STATUS')
  // Purchasing entries are paid only from Expenses → New Expense → Purchasing
  // (which also records Paid By and the expense row) — never from here.
  if (bill.source === 'purchasing') {
    throw new AppError('Purchases are paid from Expenses → New Expense → Purchasing', 400, 'PAY_VIA_EXPENSES')
  }

  if (body.amount > bill.balanceDue) {
    throw new AppError('Payment amount exceeds balance due', 400, 'OVERPAYMENT')
  }

  const [payable, paidFrom] = await Promise.all([
    resolveMappedAccount(tx, req.user.organizationId, 'ACCOUNTS_PAYABLE'),
    resolveMappedAccount(tx, req.user.organizationId, mappingKeyForPaymentMethod(body.paymentMethod)),
  ])

  const payment = await tx.payment.create({
    data: {
      ...body,
      paymentDate: new Date(body.paymentDate),
      billId: req.params.id,
      organizationId: req.user.organizationId,
      branchId: bill.branchId,
      createdBy: req.user.id,
    },
  })

  const je = await postJournalEntry(tx, {
    organizationId: req.user.organizationId,
    branchId: bill.branchId,
    entryDate: payment.paymentDate,
    referenceType: 'payment',
    referenceId: payment.id,
    sourceType: 'BILL_PAYMENT',
    sourceKey: `BILL_PAYMENT:${payment.id}:POST`,
    description: `Payment for Bill ${bill.billNo}`,
    createdBy: req.user.id,
    lines: [
      { accountId: payable.id, description: 'Payable settled', debitAmount: payment.amount },
      { accountId: paidFrom.id, description: 'Payment made', creditAmount: payment.amount },
    ],
  })
  await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: je?.id } })

  const newPaidAmount = roundMoney(bill.paidAmount + body.amount)
  const newBalanceDue = roundMoney(bill.totalAmount - newPaidAmount)
  const newStatus = newBalanceDue <= moneyTolerance() ? 'paid' : bill.paidAmount === 0 ? 'partial' : 'partial'

  await tx.bill.update({
    where: { id: req.params.id },
    data: { paidAmount: newPaidAmount, balanceDue: newBalanceDue, status: newStatus },
  })

  await logAudit(tx, { req, action: 'bill.payment_posted', module: 'purchasing', resourceType: 'payment', resourceId: payment.id })
  return { ...payment, journalEntryId: je?.id }
  })
  res.status(201).json(result)
})

// GET /suppliers/:id
router.get('/:id', requireAnyPermission('can_manage_suppliers', 'can_create_bill', 'can_approve_bill', 'can_make_payment', 'can_create_purchasing_entry', 'can_create_purchase_order', 'can_approve_purchase_order', 'can_create_expense', 'can_approve_expense', 'can_view_reports'), async (req: Request, res: Response) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const bills = await prisma.bill.findMany({
    where: { supplierId: supplier.id, organizationId: req.user.organizationId, status: { not: 'void' } },
    select: { totalAmount: true, paidAmount: true, balanceDue: true, billDate: true },
  })

  const lastPayment = await prisma.payment.findFirst({
    where: { organizationId: req.user.organizationId, bill: { supplierId: supplier.id } },
    orderBy: { paymentDate: 'desc' },
    select: { paymentDate: true },
  })

  const totalPurchases = bills.reduce((s, b) => s + b.totalAmount, 0)
  const totalPaid = bills.reduce((s, b) => s + b.paidAmount, 0)
  const totalPayable = bills.reduce((s, b) => s + b.balanceDue, 0)
  const lastPurchaseDate = bills.length > 0
    ? bills.reduce((latest, b) => (b.billDate > latest ? b.billDate : latest), bills[0].billDate)
    : null

  res.json({
    ...supplier,
    totalPurchases,
    totalPaid,
    totalPayable,
    outstandingBalance: totalPayable,
    lastPurchaseDate,
    lastPaymentDate: lastPayment?.paymentDate ?? null,
  })
})

// PUT /suppliers/:id
router.put('/:id', requirePermission('can_manage_suppliers'), async (req: Request, res: Response) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const body = updateSchema(supplierSchema).parse(req.body)
  const updated = await prisma.supplier.update({ where: { id: req.params.id }, data: body })
  res.json(updated)
})

// DELETE /suppliers/:id
router.delete('/:id', requirePermission('can_manage_suppliers'), async (req: Request, res: Response) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const hasBills = await prisma.bill.count({ where: { supplierId: req.params.id } })
  if (hasBills > 0) {
    await prisma.supplier.update({ where: { id: req.params.id }, data: { isActive: false } })
    return res.json({ message: 'Supplier deactivated (has existing bills)' })
  }

  await prisma.supplier.delete({ where: { id: req.params.id } })
  res.json({ message: 'Supplier deleted' })
})

export default router
