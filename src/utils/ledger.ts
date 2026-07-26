import { PrismaClient, Prisma, AccountingMappingKey } from '@prisma/client'
import { nextNumber } from './numbering'
import { AppError } from '../middleware/error'

// Human-readable names used in the "not configured" error message and in the
// Account Mappings settings UI.
export const MAPPING_LABELS: Record<AccountingMappingKey, string> = {
  CASH_ON_HAND: 'Cash on Hand',
  DEFAULT_BANK: 'Default Bank',
  CARD_CLEARING: 'Card Clearing',
  ACCOUNTS_RECEIVABLE: 'Accounts Receivable',
  ACCOUNTS_PAYABLE: 'Accounts Payable',
  INVENTORY: 'Inventory',
  SALES_REVENUE: 'Sales Revenue',
  OTHER_INCOME: 'Other Income',
  COST_OF_SALES: 'Cost of Sales',
  DEFAULT_EXPENSE: 'Default Expense',
  INPUT_VAT: 'Input VAT',
  OUTPUT_VAT: 'Output VAT',
  WASTAGE_EXPENSE: 'Wastage Expense',
  CASH_OVER_SHORT: 'Cash Over or Short',
  RETAINED_EARNINGS: 'Retained Earnings',
  OPENING_BALANCE_EQUITY: 'Opening Balance Equity',
}

// Resolves a well-known posting role (e.g. SALES_REVENUE) to the Account the
// organization has actually configured for it via Accounts > Settings >
// Account Mappings. Operational posting code must go through this instead of
// silently creating/guessing an account — if the mapping (or the mapped
// account itself) isn't usable, fail with a clear, actionable error naming
// only the missing mapping, so unrelated modules are never blocked.
export async function resolveMappedAccount(prisma: PrismaClient, organizationId: string, key: AccountingMappingKey) {
  const mapping = await prisma.accountingMapping.findUnique({
    where: { organizationId_key: { organizationId, key } },
    include: { account: true },
  })

  if (!mapping || mapping.account.status !== 'ACTIVE' || !mapping.account.allowManualPosting || mapping.account.isControlAccount) {
    throw new AppError(
      `${MAPPING_LABELS[key]} account is not configured. Configure it under Accounts > Settings before approving this transaction.`,
      400,
      'MAPPING_NOT_CONFIGURED'
    )
  }

  return mapping.account
}

// Maps a bill/expense/sale paymentMethod string to the mapping key that
// represents where that money actually sits.
export function mappingKeyForPaymentMethod(paymentMethod: string): AccountingMappingKey {
  switch (paymentMethod) {
    case 'bank_transfer':
    case 'bank':
    case 'cheque':
      return 'DEFAULT_BANK'
    case 'card':
      return 'CARD_CLEARING'
    case 'credit':
    case 'supplier':
      return 'ACCOUNTS_PAYABLE'
    case 'cash':
    default:
      return 'CASH_ON_HAND'
  }
}

export interface LedgerLineInput {
  accountId: string
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
  sourceType?: string
  // Required for system-generated entries so retrying an approval endpoint
  // can never create a duplicate posting (e.g. "BILL:{billId}:APPROVAL").
  // Left undefined for manually created drafts, where duplicates are expected.
  sourceKey?: string
  createdBy: string
  lines: LedgerLineInput[]
}

// Rejects postings whose date falls inside a LOCKED or CLOSED accounting
// period. An org with no period defined for that date is treated as open —
// periods are an opt-in administrative control, not mandatory up front.
export async function assertPeriodOpen(prisma: PrismaClient, organizationId: string, postingDate: Date) {
  const period = await prisma.accountingPeriod.findFirst({
    where: { organizationId, startDate: { lte: postingDate }, endDate: { gte: postingDate } },
  })
  if (period && period.status !== 'OPEN') {
    throw new AppError(
      `Posting date falls in a ${period.status.toLowerCase()} accounting period (${period.name}). Ask an administrator to unlock it first.`,
      400,
      'PERIOD_LOCKED'
    )
  }
}

// Standardized double-entry posting used across every module that moves
// money or stock (sales, expenses, supplier bills, payments, wastage, cash
// closing). System-generated entries are posted immediately (status
// "posted") since they mirror a real transaction that already happened —
// there is nothing left to "approve" at the ledger level. Idempotent when a
// sourceKey is supplied: retrying the same posting call returns the existing
// entry instead of creating a duplicate.
export async function postJournalEntry(prisma: PrismaClient, input: PostJournalEntryInput) {
  if (input.sourceKey) {
    const existing = await prisma.journalEntry.findFirst({
      where: { organizationId: input.organizationId, sourceKey: input.sourceKey },
    })
    if (existing) return existing
  }

  const filteredLines = input.lines.filter((l) => (l.debitAmount ?? 0) > 0.001 || (l.creditAmount ?? 0) > 0.001)
  if (filteredLines.length === 0) return null

  await assertPeriodOpen(prisma, input.organizationId, input.entryDate)

  const accountIds = [...new Set(filteredLines.map((l) => l.accountId))]
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } })
  const accountMap = new Map(accounts.map((a) => [a.id, a]))

  for (const accountId of accountIds) {
    const account = accountMap.get(accountId)
    if (!account || account.organizationId !== input.organizationId) {
      throw new AppError('One or more accounts on this posting were not found', 400, 'ACCOUNT_NOT_FOUND')
    }
    if (account.status !== 'ACTIVE') {
      throw new AppError(`Account ${account.code} — ${account.name} is archived and cannot receive new postings`, 400, 'ACCOUNT_ARCHIVED')
    }
    if (account.isControlAccount || !account.allowManualPosting) {
      throw new AppError(`Account ${account.code} — ${account.name} is a control account and cannot receive direct postings`, 400, 'CONTROL_ACCOUNT_POSTING')
    }
  }

  const resolvedLines = filteredLines.map((l, i) => ({
    accountId: l.accountId,
    description: l.description,
    debitAmount: Math.round((l.debitAmount ?? 0) * 100) / 100,
    creditAmount: Math.round((l.creditAmount ?? 0) * 100) / 100,
    lineOrder: i + 1,
  }))

  const totalDebit = resolvedLines.reduce((s, l) => s + l.debitAmount, 0)
  const totalCredit = resolvedLines.reduce((s, l) => s + l.creditAmount, 0)
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01
  if (!isBalanced) {
    throw new AppError('Journal entry does not balance (total debit ≠ total credit)', 400, 'UNBALANCED_ENTRY')
  }

  const entryNo = await nextNumber(prisma, 'journalEntry', 'entryNo', 'JE', input.organizationId)

  try {
    return await prisma.journalEntry.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        entryNo,
        entryDate: input.entryDate,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        sourceType: input.sourceType,
        sourceKey: input.sourceKey,
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
  } catch (err) {
    // Two concurrent requests raced past the check above — the unique
    // constraint on [organizationId, sourceKey] caught the duplicate, so
    // fetch and return the entry the other request just created instead of
    // erroring out.
    if (input.sourceKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.journalEntry.findFirst({
        where: { organizationId: input.organizationId, sourceKey: input.sourceKey },
      })
      if (existing) return existing
    }
    throw err
  }
}

// Corrections to a posted entry are made by reversing it, never by editing
// or deleting its lines. Both the original and the reversal remain status
// "posted" — together they net to zero for every account involved, which is
// what keeps Trial Balance / Balance Sheet queries (which only look at
// status "posted") correct without special-casing voided activity.
export async function reverseJournalEntry(prisma: PrismaClient, journalEntryId: string, userId: string, reason: string) {
  const original = await prisma.journalEntry.findUnique({ where: { id: journalEntryId }, include: { lines: true } })
  if (!original) throw new AppError('Journal entry not found', 404, 'NOT_FOUND')
  if (original.status !== 'posted') throw new AppError('Only posted entries can be reversed', 400, 'INVALID_STATUS')
  if (original.reversedById) throw new AppError('This journal entry has already been reversed', 400, 'ALREADY_REVERSED')

  const entryNo = await nextNumber(prisma, 'journalEntry', 'entryNo', 'JE', original.organizationId)

  const reversal = await prisma.journalEntry.create({
    data: {
      organizationId: original.organizationId,
      branchId: original.branchId,
      entryNo,
      entryDate: new Date(),
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      sourceType: original.sourceType,
      sourceKey: original.sourceKey ? `${original.sourceKey}:REVERSAL` : undefined,
      description: `Reversal of ${original.entryNo} — ${reason}`,
      status: 'posted',
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      isBalanced: original.isBalanced,
      reversalOfId: original.id,
      postedBy: userId,
      postedAt: new Date(),
      createdBy: userId,
      lines: {
        create: original.lines.map((l, i) => ({
          accountId: l.accountId,
          description: l.description ? `Reversal: ${l.description}` : 'Reversal',
          debitAmount: l.creditAmount,
          creditAmount: l.debitAmount,
          lineOrder: i + 1,
        })),
      },
    },
  })

  await prisma.journalEntry.update({ where: { id: original.id }, data: { reversedById: reversal.id } })

  return reversal
}
