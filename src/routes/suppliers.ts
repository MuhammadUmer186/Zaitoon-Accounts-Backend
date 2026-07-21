import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, accountCodeForPaymentMethod, GL } from '../utils/ledger'

const router = Router()

router.use(authenticate)

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
  paymentMethod: z.string(),
  referenceNo: z.string().optional(),
  notes: z.string().optional(),
})

// GET /suppliers
router.get('/', async (req: Request, res: Response) => {
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
router.post('/', async (req: Request, res: Response) => {
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
router.get('/bills/pending-approval', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { organizationId: req.user.organizationId, status: 'draft' }
  if (branchId) where.branchId = branchId

  const bills = await prisma.bill.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      supplier: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
  })
  res.json({ data: bills })
})

// GET /bills
router.get('/bills', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, supplierId, status, fromDate, toDate } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (supplierId) where.supplierId = supplierId
  if (status) where.status = status
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
        _count: { select: { items: true, payments: true } },
      },
    }),
    prisma.bill.count({ where }),
  ])

  res.json(paginatedResponse(bills, total, page, limit))
})

// POST /bills
router.post('/bills', async (req: Request, res: Response) => {
  const body = billSchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const billNo = await nextNumber(prisma, 'bill', 'billNo', 'BILL', req.user.organizationId)
  const balanceDue = body.totalAmount

  const { items, ...billData } = body

  const bill = await prisma.bill.create({
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

  // Standardized posting: debit the line-items' accounts when they all agree
  // on one, otherwise default to Inventory; credit Accounts Payable.
  const uniformAccountId = items && items.length > 0 && items.every((i) => i.accountId && i.accountId === items[0].accountId)
    ? items[0].accountId
    : undefined

  const je = await postJournalEntry(prisma, {
    organizationId: req.user.organizationId,
    branchId: bill.branchId,
    entryDate: bill.billDate,
    referenceType: 'bill',
    referenceId: bill.id,
    description: `Supplier Bill ${billNo}`,
    createdBy: req.user.id,
    lines: [
      { accountId: uniformAccountId, accountCode: uniformAccountId ? undefined : GL.INVENTORY, description: 'Bill items', debitAmount: bill.totalAmount },
      { accountCode: GL.AP, description: 'Payable to supplier', creditAmount: bill.totalAmount },
    ],
  })
  await prisma.bill.update({ where: { id: bill.id }, data: { journalEntryId: je?.id } })

  res.status(201).json({ ...bill, journalEntryId: je?.id })
})

// GET /bills/:id
router.get('/bills/:id', async (req: Request, res: Response) => {
  const bill = await prisma.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: { items: true, payments: true, supplier: true, branch: true },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  res.json(bill)
})

// PUT /bills/:id
router.put('/bills/:id', async (req: Request, res: Response) => {
  const bill = await prisma.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  if (bill.status !== 'draft') throw new AppError('Only draft bills can be edited', 400, 'INVALID_STATUS')

  const body = billSchema.partial().parse(req.body)
  const { items, ...billData } = body

  if (items !== undefined) {
    await prisma.billItem.deleteMany({ where: { billId: req.params.id } })
    if (items.length > 0) {
      await prisma.billItem.createMany({
        data: items.map((i) => ({ ...i, billId: req.params.id })),
      })
    }
  }

  const updated = await prisma.bill.update({
    where: { id: req.params.id },
    data: {
      ...billData,
      ...(billData.billDate && { billDate: new Date(billData.billDate) }),
      ...(billData.dueDate && { dueDate: new Date(billData.dueDate) }),
    },
    include: { items: true, payments: true, supplier: true, branch: true },
  })

  res.json(updated)
})

// POST /bills/:id/approve
router.post('/bills/:id/approve', async (req: Request, res: Response) => {
  const bill = await prisma.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  if (bill.status !== 'draft') throw new AppError('Only draft bills can be approved', 400, 'INVALID_STATUS')

  const updated = await prisma.bill.update({
    where: { id: req.params.id },
    data: { status: 'approved', approvedBy: req.user.id, approvedAt: new Date() },
  })
  res.json(updated)
})

// POST /bills/:id/void
router.post('/bills/:id/void', async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const bill = await prisma.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')

  const updated = await prisma.bill.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  res.json(updated)
})

// POST /bills/:id/payments
router.post('/bills/:id/payments', async (req: Request, res: Response) => {
  const body = paymentSchema.parse(req.body)

  const bill = await prisma.bill.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!bill) throw new AppError('Bill not found', 404, 'NOT_FOUND')
  if (bill.status === 'void') throw new AppError('Cannot pay a voided bill', 400, 'INVALID_STATUS')

  if (body.amount > bill.balanceDue) {
    throw new AppError('Payment amount exceeds balance due', 400, 'OVERPAYMENT')
  }

  const payment = await prisma.payment.create({
    data: {
      ...body,
      paymentDate: new Date(body.paymentDate),
      billId: req.params.id,
      organizationId: req.user.organizationId,
      branchId: bill.branchId,
      createdBy: req.user.id,
    },
  })

  const je = await postJournalEntry(prisma, {
    organizationId: req.user.organizationId,
    branchId: bill.branchId,
    entryDate: payment.paymentDate,
    referenceType: 'payment',
    referenceId: payment.id,
    description: `Payment for Bill ${bill.billNo}`,
    createdBy: req.user.id,
    lines: [
      { accountCode: GL.AP, description: 'Payable settled', debitAmount: payment.amount },
      { accountCode: accountCodeForPaymentMethod(payment.paymentMethod), description: 'Payment made', creditAmount: payment.amount },
    ],
  })
  await prisma.payment.update({ where: { id: payment.id }, data: { journalEntryId: je?.id } })

  const newPaidAmount = bill.paidAmount + body.amount
  const newBalanceDue = bill.totalAmount - newPaidAmount
  const newStatus = newBalanceDue <= 0.01 ? 'paid' : bill.paidAmount === 0 ? 'partial' : 'partial'

  await prisma.bill.update({
    where: { id: req.params.id },
    data: { paidAmount: newPaidAmount, balanceDue: newBalanceDue, status: newStatus },
  })

  res.status(201).json({ ...payment, journalEntryId: je?.id })
})

// GET /suppliers/:id
router.get('/:id', async (req: Request, res: Response) => {
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
router.put('/:id', async (req: Request, res: Response) => {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')

  const body = supplierSchema.partial().parse(req.body)
  const updated = await prisma.supplier.update({ where: { id: req.params.id }, data: body })
  res.json(updated)
})

// DELETE /suppliers/:id
router.delete('/:id', async (req: Request, res: Response) => {
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
