import { moneyTolerance } from '../utils/money'
import { roundMoney as regionalRoundMoney } from '../utils/money'
import { AccountingMappingKey, Prisma, PrismaClient } from '@prisma/client'
import { Request } from 'express'
import { AppError } from '../middleware/error'
import { mappingKeyForPaymentMethod, postJournalEntry, resolveMappedAccount } from '../utils/ledger'
import { businessDate } from './orderSales'
import { lockCashier } from './tills'

type Tx = Prisma.TransactionClient
export const RECEIPT_METHODS = ['cash', 'card', 'bank_transfer'] as const
const round2 = (n: number) => regionalRoundMoney(n)

export interface ReceiptInput {
  branchId: string; type: 'gift_card_sale' | 'house_account_payment'; method: typeof RECEIPT_METHODS[number]; amount: number
  requestId: string; customerId?: string | null; giftCardId?: string | null
  credit: AccountingMappingKey; description: string
}

// Money taken outside a sale (a gift card sold, a house account paid). Cash
// goes into the cashier's open till and the branch's cash closing; the
// journal credits the liability or receivable it settles. Idempotent by
// request ID; the same cashier and branch cash locks as order payments.
export async function takeReceipt(tx: Tx, req: Request, input: ReceiptInput) {
  const orgId = req.user.organizationId
  const previous = await tx.customerReceipt.findUnique({ where: { organizationId_requestId: { organizationId: orgId, requestId: input.requestId } } })
  if (previous) {
    if (previous.type !== input.type || previous.method !== input.method || Math.abs(previous.amount - input.amount) > moneyTolerance() || previous.branchId !== input.branchId || (input.customerId ?? null) !== previous.customerId) throw new AppError('This request ID was already used for a different receipt', 409, 'RECEIPT_REQUEST_CONFLICT')
    return { receipt: previous, duplicate: true }
  }
  await lockCashier(tx, input.branchId, req.user.id)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-settlement:${input.branchId}`}))`
  const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { timezone: true, requireTillForCash: true } })
  const day = businessDate(org.timezone)
  if (await tx.cashClosing.count({ where: { branchId: input.branchId, closingDate: day, status: 'approved' } })) throw new AppError('Today’s cash closing is approved; reopen it before taking money', 409, 'CLOSING_APPROVED')
  const till = await tx.tillSession.findFirst({ where: { organizationId: orgId, branchId: input.branchId, userId: req.user.id, status: 'open' } })
  if (input.method === 'cash' && org.requireTillForCash && !till) throw new AppError('Open your till at this branch before taking cash', 409, 'TILL_REQUIRED')
  const db = tx as unknown as PrismaClient
  const [debit, credit] = await Promise.all([resolveMappedAccount(db, orgId, mappingKeyForPaymentMethod(input.method)), resolveMappedAccount(db, orgId, input.credit)])
  const receipt = await tx.customerReceipt.create({ data: {
    organizationId: orgId, branchId: input.branchId, type: input.type, method: input.method, amount: round2(input.amount),
    customerId: input.customerId ?? null, giftCardId: input.giftCardId ?? null, tillSessionId: input.method === 'cash' ? till?.id ?? null : null,
    userId: req.user.id, requestId: input.requestId, businessDate: day,
  } })
  const je = await postJournalEntry(db, {
    organizationId: orgId, branchId: input.branchId, entryDate: day, referenceType: 'customer_receipt', referenceId: receipt.id,
    sourceType: 'CUSTOMER_RECEIPT', sourceKey: `CUSTOMER_RECEIPT:${receipt.id}`, description: input.description, createdBy: req.user.id,
    lines: [
      { accountId: debit.id, description: input.description, debitAmount: round2(input.amount) },
      { accountId: credit.id, description: input.description, creditAmount: round2(input.amount) },
    ],
  })
  return { receipt: await tx.customerReceipt.update({ where: { id: receipt.id }, data: { journalEntryId: je?.id ?? null } }), duplicate: false }
}

// Cash received outside sales for a branch's business day (cash closing)
export async function receiptCash(db: Tx | PrismaClient, organizationId: string, branchId: string, day: Date) {
  const agg = await db.customerReceipt.aggregate({ where: { organizationId, branchId, businessDate: day, method: 'cash' }, _sum: { amount: true } })
  return round2(agg._sum.amount ?? 0)
}
