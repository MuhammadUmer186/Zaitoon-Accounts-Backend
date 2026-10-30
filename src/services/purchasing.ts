import { roundMoney, runWithCurrency, validMoneyPrecision } from '../utils/money'
import { PrismaClient } from '@prisma/client'
import { nextNumber } from '../utils/numbering'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod } from '../utils/ledger'
import { applyStockIn } from '../utils/stock'
import { AppError } from '../middleware/error'
import { lockPurchasing, recordPurchasePayment } from './purchasePayments'
import { toHijriDate } from '../utils/hijriDate'
import { financeLock } from '../utils/financeTransaction'

export interface PurchaseItemInput {
  itemId?: string
  description: string
  quantity: number
  unitCost: number
}

export interface CreatePurchaseBillParams {
  organizationId: string
  branchId: string
  supplierId: string
  supplierName: string
  supplierBillNo?: string
  categoryId?: string
  supplyDate: Date
  paymentDate: Date
  paymentType: 'cash' | 'bank_transfer'
  vatPercent: number
  discountAmount?: number
  amountPaid: number
  items: PurchaseItemInput[]
  createdBy: string
  paidBy?: string
  paymentDocumentId?: string
}

// Core "Purchasing" posting logic — creates the Bill (+ items), posts the
// approval journal entry, optionally records/posts a payment, and applies
// stock-in for any catalog-linked line. Shared by the one-shot manual entry
// endpoint and the bulk CSV/Excel import, which both need identical
// accounting behavior; only supplier resolution and file attachments differ
// between the two callers.
export async function createPurchaseBill(prisma: PrismaClient, params: CreatePurchaseBillParams) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: params.organizationId }, select: { currency: true } })
  return runWithCurrency(org.currency, () => createPurchaseBillInCurrency(prisma, params))
}

async function createPurchaseBillInCurrency(prisma: PrismaClient, params: CreatePurchaseBillParams) {
  await lockPurchasing(prisma, params.organizationId)
  if (!params.items.length || params.items.some(i => !Number.isFinite(i.quantity) || i.quantity <= 0 || !Number.isFinite(i.unitCost) || i.unitCost < 0)) throw new AppError('Invalid purchase items', 400, 'VALIDATION_ERROR')
  if (!Number.isFinite(params.supplyDate.getTime()) || !Number.isFinite(params.paymentDate.getTime())) throw new AppError('Invalid purchase date', 400, 'VALIDATION_ERROR')
  const linkedIds = [...new Set(params.items.map(i => i.itemId).filter((id): id is string => !!id))]
  if (linkedIds.length !== await prisma.item.count({ where: { id: { in: linkedIds }, organizationId: params.organizationId, isActive: true } })) throw new AppError('One or more stock items were not found', 400, 'VALIDATION_ERROR')
  if (!Number.isFinite(params.vatPercent) || params.vatPercent < 0 || params.vatPercent > 100) throw new AppError('Invalid tax rate', 400, 'VALIDATION_ERROR')
  const supplierBillNo = params.supplierBillNo?.trim() || undefined
  if (supplierBillNo) {
    await financeLock(prisma, `vendor-invoice:${params.organizationId}:${params.supplierId}`)
    const duplicate = await prisma.bill.findFirst({ where: { organizationId: params.organizationId, supplierId: params.supplierId, supplierBillNo: { equals: supplierBillNo, mode: 'insensitive' }, status: { not: 'void' } } })
    if (duplicate) throw new AppError('This supplier invoice has already been entered', 400, 'DUPLICATE_VENDOR_INVOICE')
  }
  const gross = params.items.map(item => roundMoney(item.quantity * item.unitCost))
  const subtotal = roundMoney(gross.reduce((sum, value) => sum + value, 0))
  const discountAmount = roundMoney(params.discountAmount ?? 0)
  if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) throw new AppError('Invalid purchase discount', 400, 'VALIDATION_ERROR')
  // Spread the bill discount across lines by cumulative share so the line
  // nets add up exactly to subtotal − discount; tax is charged on the net.
  let cumulative = 0, allocated = 0
  const lines = params.items.map((item, index) => {
    cumulative = roundMoney(cumulative + gross[index])
    const targetDiscount = roundMoney(subtotal > 0 ? discountAmount * cumulative / subtotal : 0)
    const base = roundMoney(gross[index] - (targetDiscount - allocated))
    allocated = targetDiscount
    const tax = roundMoney(base * params.vatPercent / 100)
    return { ...item, base, tax, total: roundMoney(base + tax) }
  })
  const vatAmount = roundMoney(lines.reduce((sum, item) => sum + item.tax, 0))
  const totalAmount = roundMoney(subtotal - discountAmount + vatAmount)
  if (totalAmount <= 0) throw new AppError('Purchase total must be positive', 400, 'VALIDATION_ERROR')
  if (!validMoneyPrecision(params.amountPaid) || params.amountPaid < 0 || params.amountPaid > totalAmount) throw new AppError('Invalid amount paid for this currency', 400, 'OVERPAYMENT')
  const paidAmount = params.amountPaid
  const balanceDue = roundMoney(totalAmount - paidAmount)
  const status = balanceDue === 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'approved'

  const billNo = await nextNumber(prisma, 'bill', 'billNo', 'BILL', params.organizationId)

  const createdBill = await prisma.bill.create({
    data: {
      organizationId: params.organizationId,
      branchId: params.branchId,
      supplierId: params.supplierId,
      supplierBillNo,
      billNo,
      billDate: params.supplyDate,
      dueDate: params.paymentDate,
      subtotal,
      discountAmount,
      vatAmount,
      totalAmount,
      paidAmount: 0,
      balanceDue: totalAmount,
      status: 'approved',
      source: 'purchasing',
      categoryId: params.categoryId,
      hijriDate: toHijriDate(params.supplyDate),
      createdBy: params.createdBy,
      items: {
        create: lines.map((i) => ({
          description: i.description, quantity: i.quantity, unitPrice: i.unitCost,
          vatRate: params.vatPercent, vatAmount: i.tax, totalAmount: i.total, itemId: i.itemId,
        })),
      },
    },
  })

  const stockTotal = roundMoney(lines.filter(i => i.itemId).reduce((sum, i) => sum + i.base, 0))
  const otherTotal = roundMoney(subtotal - discountAmount - stockTotal)
  const category = params.categoryId ? await prisma.expenseCategory.findFirst({ where: { id: params.categoryId, organizationId: params.organizationId, isActive: true } }) : null
  if (params.categoryId && !category) throw new AppError('Category not found', 404, 'NOT_FOUND')
  const [inventoryAccount, otherAccount, inputVat, payable] = await Promise.all([
    stockTotal > 0 ? resolveMappedAccount(prisma, params.organizationId, 'INVENTORY') : null,
    otherTotal > 0 ? (category?.accountId ? prisma.account.findFirstOrThrow({ where: { id: category.accountId, organizationId: params.organizationId } }) : resolveMappedAccount(prisma, params.organizationId, 'DEFAULT_EXPENSE')) : null,
    vatAmount > 0 ? resolveMappedAccount(prisma, params.organizationId, 'INPUT_VAT') : null,
    resolveMappedAccount(prisma, params.organizationId, 'ACCOUNTS_PAYABLE'),
  ])

  const billJe = await postJournalEntry(prisma, {
    organizationId: params.organizationId,
    branchId: params.branchId,
    entryDate: params.supplyDate,
    referenceType: 'bill',
    referenceId: createdBill.id,
    sourceType: 'BILL',
    sourceKey: `BILL:${createdBill.id}:APPROVAL`,
    description: `Purchase ${billNo} — ${params.supplierName}`,
    createdBy: params.createdBy,
    lines: [
      ...(inventoryAccount ? [{ accountId: inventoryAccount.id, description: 'Purchased stock', debitAmount: stockTotal }] : []),
      ...(otherAccount ? [{ accountId: otherAccount.id, description: 'Non-stock purchase', debitAmount: otherTotal }] : []),
      ...(inputVat ? [{ accountId: inputVat.id, description: 'Input VAT', debitAmount: vatAmount }] : []),
      { accountId: payable.id, description: 'Payable to vendor', creditAmount: totalAmount },
    ],
  })
  await prisma.bill.update({ where: { id: createdBill.id }, data: { journalEntryId: billJe?.id } })

  let createdPayment: { id: string } | null = null
  if (paidAmount > 0) {
    const result = await recordPurchasePayment(prisma, {
      organizationId: params.organizationId, billId: createdBill.id, createdBy: params.createdBy,
      paymentDate: params.paymentDate, amount: paidAmount, paymentMethod: params.paymentType,
      paidBy: params.paidBy || 'Imported payment', documentId: params.paymentDocumentId,
    })
    createdPayment = result.payment
  }

  for (const item of lines) {
    if (!item.itemId) continue // free-text lines aren't linked to a stock item
    await applyStockIn(prisma, {
      organizationId: params.organizationId,
      branchId: params.branchId,
      itemId: item.itemId,
      quantity: item.quantity,
      unitCost: item.base / item.quantity, // discounted cost
      referenceType: 'purchase',
      referenceId: createdBill.id,
      notes: `Purchased via Purchasing — ${billNo}`,
      createdBy: params.createdBy,
    })
  }

  return { bill: { ...createdBill, paidAmount, balanceDue, status }, payment: createdPayment }
}
