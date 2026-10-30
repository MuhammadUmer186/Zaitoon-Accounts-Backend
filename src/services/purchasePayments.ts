import { roundMoney, runWithCurrency, validMoneyPrecision } from '../utils/money'
import { currencyDecimals } from '../utils/regions'
import { PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'
import { nextNumber } from '../utils/numbering'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod } from '../utils/ledger'

// Call only inside a transaction. The organization lock also protects the
// existing human-readable expense/journal number allocator.
export async function lockPurchasing(db: PrismaClient, organizationId: string) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchasing:${organizationId}`}))`
}

interface PurchasePaymentInput {
  organizationId: string; billId: string; createdBy: string; amount: number
  paymentDate: Date; paymentMethod: string; paidBy: string
  requestId?: string; referenceNo?: string; notes?: string; documentId?: string
}

export async function recordPurchasePayment(db: PrismaClient, input: PurchasePaymentInput) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { currency: true } })
  return runWithCurrency(org.currency, () => recordInCurrency(db, input, org.currency))
}

async function recordInCurrency(db: PrismaClient, input: PurchasePaymentInput, currency: string) {
  await lockPurchasing(db, input.organizationId)
  await db.$queryRaw`SELECT id FROM "Bill" WHERE id = ${input.billId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
  const bill = await db.bill.findFirst({ where: { id: input.billId, organizationId: input.organizationId, source: 'purchasing' }, include: { supplier: true, branch: true } })
  if (!bill) throw new AppError('Purchase not found', 404, 'NOT_FOUND')
  if (input.requestId) {
    const existing = await db.payment.findUnique({ where: { id: input.requestId } })
    if (existing) {
      if (existing.organizationId !== input.organizationId || existing.billId !== bill.id || existing.amount !== input.amount || existing.paymentMethod !== input.paymentMethod || existing.paymentDate.getTime() !== input.paymentDate.getTime() || existing.paidBy !== input.paidBy) throw new AppError('Payment request ID already used', 409, 'DUPLICATE_REQUEST')
      const expense = await db.expense.findFirst({ where: { paymentId: existing.id, organizationId: input.organizationId } })
      if (!expense || expense.status === 'void') throw new AppError('This payment request has already been reversed', 409, 'DUPLICATE_REQUEST')
      return { payment: existing, expense }
    }
  }
  if (!['approved', 'partial'].includes(bill.status)) throw new AppError('This purchase is not pending payment', 400, 'INVALID_STATUS')
  const amount = roundMoney(input.amount)
  if (amount <= 0 || !validMoneyPrecision(input.amount)) throw new AppError(`Payment must be positive and use at most ${currencyDecimals(currency)} decimal places for ${currency}`, 400, 'VALIDATION_ERROR')
  if (!Number.isFinite(input.paymentDate.getTime())) throw new AppError('Invalid payment date', 400, 'VALIDATION_ERROR')
  if (amount > roundMoney(bill.balanceDue)) throw new AppError('Payment amount exceeds balance due', 400, 'OVERPAYMENT')
  const payment = await db.payment.create({ data: {
    ...(input.requestId && { id: input.requestId }),
    organizationId: input.organizationId, branchId: bill.branchId, billId: bill.id,
    paymentDate: input.paymentDate, amount, paymentMethod: input.paymentMethod,
    paidBy: input.paidBy, referenceNo: input.referenceNo, notes: input.notes,
    documentId: input.documentId, createdBy: input.createdBy,
  } })
  const [payable, paidFrom] = await Promise.all([
    resolveMappedAccount(db, input.organizationId, 'ACCOUNTS_PAYABLE'),
    resolveMappedAccount(db, input.organizationId, mappingKeyForPaymentMethod(input.paymentMethod)),
  ])
  const je = await postJournalEntry(db, {
    organizationId: input.organizationId, branchId: bill.branchId, entryDate: input.paymentDate,
    referenceType: 'payment', referenceId: payment.id, sourceType: 'BILL_PAYMENT', sourceKey: `BILL_PAYMENT:${payment.id}:POST`,
    description: `Payment for Purchase ${bill.billNo} — ${bill.supplier.name}`, createdBy: input.createdBy,
    lines: [{ accountId: payable.id, debitAmount: amount }, { accountId: paidFrom.id, creditAmount: amount }],
  })
  await db.payment.update({ where: { id: payment.id }, data: { journalEntryId: je?.id } })
  const paidAmount = roundMoney(bill.paidAmount + amount)
  const balanceDue = Math.max(0, roundMoney(bill.totalAmount - paidAmount))
  await db.bill.update({ where: { id: bill.id }, data: { paidAmount, balanceDue, status: balanceDue === 0 ? 'paid' : 'partial' } })
  // Preserve legacy expense links. These are payment receipts, excluded from
  // the combined spending register and cost totals.
  const categoryId = bill.categoryId ?? (await db.expenseCategory.upsert({ where: { organizationId_name: { organizationId: input.organizationId, name: 'Uncategorised purchases' } }, update: { isActive: true }, create: { organizationId: input.organizationId, name: 'Uncategorised purchases' } })).id
  if (!bill.categoryId) await db.bill.update({ where: { id: bill.id }, data: { categoryId } })
  const expenseNo = await nextNumber(db, 'expense', 'expenseNo', bill.branch.expensePrefix || 'EXP', input.organizationId)
  const expense = await db.expense.create({ data: {
    organizationId: input.organizationId, branchId: bill.branchId, expenseNo, expenseDate: input.paymentDate,
    categoryId, description: `Payment for Purchase ${bill.billNo} — ${bill.supplier.name}`,
    amount, vatAmount: 0, vatRate: 0, totalAmount: amount, paymentMethod: input.paymentMethod,
    source: 'purchasing', billId: bill.id, paymentId: payment.id, paidBy: input.paidBy,
    supplierId: bill.supplierId, receiptDocumentId: input.documentId, status: 'approved',
    approvedBy: input.createdBy, approvedAt: new Date(), journalEntryId: je?.id, notes: input.notes, createdBy: input.createdBy,
  } })
  return { payment: { ...payment, journalEntryId: je?.id }, expense }
}
