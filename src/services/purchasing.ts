import { PrismaClient } from '@prisma/client'
import { nextNumber } from '../utils/numbering'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod } from '../utils/ledger'
import { applyStockIn } from '../utils/stock'
import { toHijriDate } from '../utils/hijriDate'

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
  supplyDate: Date
  paymentDate: Date
  paymentType: 'cash' | 'bank_transfer'
  vatPercent: number
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
  const subtotal = params.items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0)
  const vatAmount = Math.round(subtotal * (params.vatPercent / 100) * 100) / 100
  const totalAmount = subtotal + vatAmount
  const paidAmount = params.amountPaid
  const balanceDue = totalAmount - paidAmount
  const status = balanceDue <= 0.01 ? 'paid' : paidAmount > 0 ? 'partial' : 'approved'

  const billNo = await nextNumber(prisma, 'bill', 'billNo', 'BILL', params.organizationId)

  const createdBill = await prisma.bill.create({
    data: {
      organizationId: params.organizationId,
      branchId: params.branchId,
      supplierId: params.supplierId,
      billNo,
      billDate: params.supplyDate,
      dueDate: params.paymentDate,
      subtotal,
      vatAmount,
      totalAmount,
      paidAmount,
      balanceDue,
      status,
      source: 'purchasing',
      hijriDate: toHijriDate(params.supplyDate),
      createdBy: params.createdBy,
      items: {
        create: params.items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitCost,
          vatRate: params.vatPercent,
          vatAmount: Math.round(i.quantity * i.unitCost * (params.vatPercent / 100) * 100) / 100,
          totalAmount: Math.round(i.quantity * i.unitCost * (1 + params.vatPercent / 100) * 100) / 100,
          itemId: i.itemId,
        })),
      },
    },
  })

  const [inventoryAccount, inputVat, payable] = await Promise.all([
    resolveMappedAccount(prisma, params.organizationId, 'INVENTORY'),
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
      { accountId: inventoryAccount.id, description: 'Purchased goods', debitAmount: subtotal },
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

  for (const item of params.items) {
    if (!item.itemId) continue // free-text lines aren't linked to a stock item
    await applyStockIn(prisma, {
      organizationId: params.organizationId,
      branchId: params.branchId,
      itemId: item.itemId,
      quantity: item.quantity,
      unitCost: item.unitCost,
      referenceType: 'purchase',
      referenceId: createdBill.id,
      notes: `Purchased via Purchasing — ${billNo}`,
      createdBy: params.createdBy,
    })
  }

  return { bill: createdBill, payment: createdPayment }
}
