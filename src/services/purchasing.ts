import { PrismaClient } from '@prisma/client'
import { nextNumber } from '../utils/numbering'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod } from '../utils/ledger'
import { applyStockIn } from '../utils/stock'
import { toHijriDate } from '../utils/hijriDate'
import { financeTransaction, financeLock } from '../utils/financeTransaction'
import { AppError } from '../middleware/error'

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
}

// Core "Purchasing" posting logic — creates the Bill (+ items), posts the
// approval journal entry, optionally records/posts a payment, and applies
// stock-in for any catalog-linked line. Shared by the one-shot manual entry
// endpoint and the bulk CSV/Excel import, which both need identical
// accounting behavior; only supplier resolution and file attachments differ
// between the two callers.
export async function createPurchaseBill(prisma: PrismaClient, params: CreatePurchaseBillParams) {
  return financeTransaction(prisma, (tx) => createPurchaseInTransaction(tx, params))
}

async function createPurchaseInTransaction(prisma: PrismaClient, params: CreatePurchaseBillParams) {
  if (!params.items.length || params.items.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitCost) || item.unitCost < 0)) throw new AppError('Invalid purchase lines', 400, 'VALIDATION_ERROR')
  if (!Number.isFinite(params.vatPercent) || params.vatPercent < 0 || params.vatPercent > 100 || !Number.isFinite(params.amountPaid) || params.amountPaid < 0) throw new AppError('Invalid tax or payment amount', 400, 'VALIDATION_ERROR')
  const supplierBillNo = params.supplierBillNo?.trim() || undefined
  if (supplierBillNo) {
    await financeLock(prisma, `vendor-invoice:${params.organizationId}:${params.supplierId}`)
    const duplicate = await prisma.bill.findFirst({ where: { organizationId: params.organizationId, supplierId: params.supplierId, supplierBillNo: { equals: supplierBillNo, mode: 'insensitive' }, status: { not: 'void' } } })
    if (duplicate) throw new AppError('This supplier invoice has already been entered', 400, 'DUPLICATE_VENDOR_INVOICE')
  }
  const round = (value: number) => Math.round(value * 100) / 100
  const subtotal = round(params.items.reduce((sum, i) => sum + round(i.quantity * i.unitCost), 0))
  const discountAmount = round(params.discountAmount ?? 0)
  if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) throw new AppError('Invalid purchase discount', 400, 'VALIDATION_ERROR')
  let cumulative = 0, allocated = 0
  const lineAmounts = params.items.map((item) => {
    const gross = round(item.quantity * item.unitCost)
    cumulative = round(cumulative + gross)
    const targetDiscount = round(subtotal > 0 ? discountAmount * cumulative / subtotal : 0)
    const net = round(gross - (targetDiscount - allocated))
    allocated = targetDiscount
    const vat = round(net * params.vatPercent / 100)
    return { net, vat, total: round(net + vat) }
  })
  const vatAmount = round(lineAmounts.reduce((sum, line) => sum + line.vat, 0))
  const totalAmount = round(subtotal - discountAmount + vatAmount)
  if (params.amountPaid > totalAmount) throw new AppError('Payment amount exceeds purchase total', 400, 'OVERPAYMENT')
  const paidAmount = params.amountPaid
  const balanceDue = totalAmount - paidAmount
  const status = balanceDue <= 0.01 ? 'paid' : paidAmount > 0 ? 'partial' : 'approved'

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
      paidAmount,
      balanceDue,
      status,
      source: 'purchasing',
      categoryId: params.categoryId,
      hijriDate: toHijriDate(params.supplyDate),
      createdBy: params.createdBy,
      items: {
        create: params.items.map((i, index) => ({
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitCost,
          vatRate: params.vatPercent,
          vatAmount: lineAmounts[index].vat,
          totalAmount: lineAmounts[index].total,
          itemId: i.itemId,
        })),
      },
    },
  })

  const stockAmount = round(params.items.reduce((sum, i, index) => sum + (i.itemId ? lineAmounts[index].net : 0), 0))
  const expenseAmount = round(subtotal - discountAmount - stockAmount)
  const category = expenseAmount > 0 && params.categoryId ? await prisma.expenseCategory.findFirst({ where: { id: params.categoryId, organizationId: params.organizationId } }) : null
  const [inventoryAccount, expenseAccount, inputVat, payable] = await Promise.all([
    stockAmount > 0 ? resolveMappedAccount(prisma, params.organizationId, 'INVENTORY') : null,
    expenseAmount > 0 ? (category?.accountId ? prisma.account.findUniqueOrThrow({ where: { id: category.accountId } }) : resolveMappedAccount(prisma, params.organizationId, 'DEFAULT_EXPENSE')) : null,
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
      ...(inventoryAccount ? [{ accountId: inventoryAccount.id, description: 'Purchased stock', debitAmount: stockAmount }] : []),
      ...(expenseAccount ? [{ accountId: expenseAccount.id, description: 'Non-stock purchases', debitAmount: expenseAmount }] : []),
      ...(inputVat ? [{ accountId: inputVat.id, description: 'Input VAT', debitAmount: vatAmount }] : []),
      { accountId: payable.id, description: 'Payable to vendor', creditAmount: totalAmount },
    ],
  })
  await prisma.bill.update({ where: { id: createdBill.id }, data: { journalEntryId: billJe?.id } })

  let createdPayment: { id: string } | null = null
  if (paidAmount > 0) {
    createdPayment = await prisma.payment.create({
      data: {
        organizationId: params.organizationId,
        branchId: params.branchId,
        billId: createdBill.id,
        paymentDate: params.paymentDate,
        amount: paidAmount,
        paymentMethod: params.paymentType,
        createdBy: params.createdBy,
      },
    })

    const paidFrom = await resolveMappedAccount(prisma, params.organizationId, mappingKeyForPaymentMethod(params.paymentType))

    const paymentJe = await postJournalEntry(prisma, {
      organizationId: params.organizationId,
      branchId: params.branchId,
      entryDate: params.paymentDate,
      referenceType: 'payment',
      referenceId: createdPayment.id,
      sourceType: 'BILL_PAYMENT',
      sourceKey: `BILL_PAYMENT:${createdPayment.id}:POST`,
      description: `Payment for Purchase ${billNo}`,
      createdBy: params.createdBy,
      lines: [
        { accountId: payable.id, description: 'Payable settled', debitAmount: paidAmount },
        { accountId: paidFrom.id, description: 'Payment made', creditAmount: paidAmount },
      ],
    })
    await prisma.payment.update({ where: { id: createdPayment.id }, data: { journalEntryId: paymentJe?.id } })
  }

  for (const [index, item] of params.items.entries()) {
    if (!item.itemId) continue // free-text lines aren't linked to a stock item
    await applyStockIn(prisma, {
      organizationId: params.organizationId,
      branchId: params.branchId,
      itemId: item.itemId,
      quantity: item.quantity,
      unitCost: lineAmounts[index].net / item.quantity,
      referenceType: 'purchase',
      referenceId: createdBill.id,
      notes: `Purchased via Purchasing — ${billNo}`,
      createdBy: params.createdBy,
    })
  }

  return { bill: createdBill, payment: createdPayment }
}
