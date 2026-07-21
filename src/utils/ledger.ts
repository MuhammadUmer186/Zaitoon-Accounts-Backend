import { PrismaClient } from '@prisma/client'
import { nextNumber } from './numbering'

// Standard chart-of-accounts codes used by the auto-posting system.
// These match backend/prisma/seed.js — if an org's chart is missing one
// (e.g. never re-seeded), getOrCreateAccount() creates it on the fly so
// posting never fails.
export const GL = {
  CASH: '1000',
  BANK: '1010',
  PETTY_CASH: '1020',
  AR: '1100',
  VAT_RECOVERABLE: '1110',
  INVENTORY: '1200',
  CARD_CLEARING: '1400',
  DELIVERY_CLEARING: '1410',
  AP: '2000',
  VAT_PAYABLE: '2100',
  SALES_REVENUE: '4000',
  DELIVERY_REVENUE: '4010',
  OTHER_REVENUE: '4020',
  FOOD_COST: '5100',
  WASTAGE_EXPENSE: '5400',
  MISC_EXPENSE: '6700',
} as const

const ACCOUNT_DEFAULTS: Record<string, { name: string; accountType: string; normalBalance: string }> = {
  [GL.CASH]: { name: 'Cash', accountType: 'asset', normalBalance: 'debit' },
  [GL.BANK]: { name: 'Bank Account', accountType: 'asset', normalBalance: 'debit' },
  [GL.PETTY_CASH]: { name: 'Petty Cash', accountType: 'asset', normalBalance: 'debit' },
  [GL.AR]: { name: 'Accounts Receivable', accountType: 'asset', normalBalance: 'debit' },
  [GL.VAT_RECOVERABLE]: { name: 'VAT Recoverable (Input)', accountType: 'asset', normalBalance: 'debit' },
  [GL.INVENTORY]: { name: 'Inventory', accountType: 'asset', normalBalance: 'debit' },
  [GL.CARD_CLEARING]: { name: 'Card Clearing', accountType: 'asset', normalBalance: 'debit' },
  [GL.DELIVERY_CLEARING]: { name: 'Delivery Platform Receivable', accountType: 'asset', normalBalance: 'debit' },
  [GL.AP]: { name: 'Accounts Payable', accountType: 'liability', normalBalance: 'credit' },
  [GL.VAT_PAYABLE]: { name: 'VAT Payable', accountType: 'liability', normalBalance: 'credit' },
  [GL.SALES_REVENUE]: { name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit' },
  [GL.DELIVERY_REVENUE]: { name: 'Delivery Revenue', accountType: 'revenue', normalBalance: 'credit' },
  [GL.OTHER_REVENUE]: { name: 'Other Revenue', accountType: 'revenue', normalBalance: 'credit' },
  [GL.FOOD_COST]: { name: 'Food Cost', accountType: 'expense', normalBalance: 'debit' },
  [GL.WASTAGE_EXPENSE]: { name: 'Wastage & Spoilage', accountType: 'expense', normalBalance: 'debit' },
  [GL.MISC_EXPENSE]: { name: 'Miscellaneous', accountType: 'expense', normalBalance: 'debit' },
}

// Looks up a standard account by code, creating it (idempotently) if the
// organization's chart of accounts doesn't have it yet.
export async function getOrCreateAccount(prisma: PrismaClient, organizationId: string, code: string) {
  const existing = await prisma.account.findFirst({ where: { organizationId, code } })
  if (existing) return existing

  const def = ACCOUNT_DEFAULTS[code] ?? { name: code, accountType: 'asset', normalBalance: 'debit' }
  return prisma.account.create({
    data: { organizationId, code, name: def.name, accountType: def.accountType, normalBalance: def.normalBalance },
  })
}

// Maps a bill/expense/sale paymentMethod string to the GL account that
// represents where that money actually sits.
export function accountCodeForPaymentMethod(paymentMethod: string): string {
  switch (paymentMethod) {
    case 'bank_transfer':
    case 'bank':
      return GL.BANK
    case 'card':
      return GL.CARD_CLEARING
    case 'cheque':
      return GL.BANK
    case 'credit':
    case 'supplier':
      return GL.AP
    case 'cash':
    default:
      return GL.CASH
  }
}

export interface LedgerLineInput {
  accountCode?: string
  accountId?: string
  description?: string
  debitAmount?: number
  creditAmount?: number
}

export interface PostJournalEntryInput {
  organizationId: string
  branchId: string
  entryDate: Date
  description: string
  referenceType: string
  referenceId: string
  createdBy: string
  lines: LedgerLineInput[]
}

// Standardized double-entry posting used across every module that moves
// money or stock (sales, expenses, supplier bills, payments, wastage).
// System-generated entries are posted immediately (status "posted") since
// they mirror a real transaction that already happened — there is nothing
// left to "approve" at the ledger level.
export async function postJournalEntry(prisma: PrismaClient, input: PostJournalEntryInput) {
  const resolvedLines = await Promise.all(
    input.lines
      .filter((l) => (l.debitAmount ?? 0) > 0.001 || (l.creditAmount ?? 0) > 0.001)
      .map(async (l, i) => {
        const accountId = l.accountId ?? (await getOrCreateAccount(prisma, input.organizationId, l.accountCode!)).id
        return {
          accountId,
          description: l.description,
          debitAmount: Math.round((l.debitAmount ?? 0) * 100) / 100,
          creditAmount: Math.round((l.creditAmount ?? 0) * 100) / 100,
          lineOrder: i + 1,
        }
      })
  )

  if (resolvedLines.length === 0) return null

  const totalDebit = resolvedLines.reduce((s, l) => s + l.debitAmount, 0)
  const totalCredit = resolvedLines.reduce((s, l) => s + l.creditAmount, 0)
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01

  const entryNo = await nextNumber(prisma, 'journalEntry', 'entryNo', 'JE', input.organizationId)

  return prisma.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      entryNo,
      entryDate: input.entryDate,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      status: 'posted',
      totalDebit,
      totalCredit,
      isBalanced,
      postedBy: input.createdBy,
      postedAt: new Date(),
      createdBy: input.createdBy,
      lines: { create: resolvedLines },
    },
  })
}
