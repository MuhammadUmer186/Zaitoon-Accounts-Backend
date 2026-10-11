import { PrismaClient, AccountingMappingKey } from '@prisma/client'
import { nextNumber } from './numbering'
import { AppError } from '../middleware/error'
import { financeTransaction, financeLock } from './financeTransaction'

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
  if (!Number.isFinite(postingDate.getTime())) throw new AppError('Invalid posting date', 400, 'VALIDATION_ERROR')
  await financeLock(prisma, `period:${organizationId}`)
  const period = await prisma.accountingPeriod.findFirst({
    // Period boundaries are calendar dates. This also protects the final day
    // of older periods saved with a midnight endDate.
    where: { organizationId, status: { not: 'OPEN' }, startDate: { lte: postingDate }, endDate: { gte: new Date(Date.UTC(postingDate.getUTCFullYear(), postingDate.getUTCMonth(), postingDate.getUTCDate())) } },
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
  return financeTransaction(prisma, (tx) => postJournalEntryInTransaction(tx, input))
}

export function validateJournalLines(lines: LedgerLineInput[], requireBalanced = true) {
  for (const line of lines) {
    const debit = line.debitAmount ?? 0
    const credit = line.creditAmount ?? 0
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0 || (debit > 0 && credit > 0)) {
      throw new AppError('Journal lines require finite nonnegative amounts on only one side', 400, 'INVALID_JOURNAL_LINE')
    }
  }
  const resolvedLines = lines.map((line, i) => ({ ...line, debitAmount: Math.round((line.debitAmount ?? 0) * 100) / 100, creditAmount: Math.round((line.creditAmount ?? 0) * 100) / 100, lineOrder: i + 1 }))
  const debitCents = resolvedLines.reduce((sum, line) => sum + Math.round(line.debitAmount * 100), 0)
  const creditCents = resolvedLines.reduce((sum, line) => sum + Math.round(line.creditAmount * 100), 0)
  const isBalanced = debitCents === creditCents && debitCents > 0
  if (requireBalanced && !isBalanced) throw new AppError('Journal entry does not balance or has no value', 400, 'UNBALANCED_ENTRY')
  return { resolvedLines, totalDebit: debitCents / 100, totalCredit: creditCents / 100, isBalanced }
}

export async function validatePostingAccounts(prisma: PrismaClient, organizationId: string, lines: LedgerLineInput[]) {
  const ids = [...new Set(lines.map((line) => line.accountId))]
  const accounts = await prisma.account.findMany({ where: { id: { in: ids } } })
  for (const id of ids) {
    const account = accounts.find((a) => a.id === id)
    if (!account || account.organizationId !== organizationId) throw new AppError('One or more accounts on this posting were not found', 400, 'ACCOUNT_NOT_FOUND')
    if (account.status !== 'ACTIVE' || account.isHeader || account.isControlAccount || !account.allowManualPosting) {
      throw new AppError('Account is archived, a header or does not allow direct postings', 400, 'ACCOUNT_NOT_POSTABLE')
    }
  }
}

async function postJournalEntryInTransaction(prisma: PrismaClient, input: PostJournalEntryInput) {
  await financeLock(prisma, `period:${input.organizationId}`)
  // Serialize retries before querying sourceKey, avoiding an aborted PostgreSQL
  // transaction after a unique-key conflict.
  if (input.sourceKey) await financeLock(prisma, `journal:${input.organizationId}:${input.sourceKey}`)
  if (input.sourceKey) {
    const existing = await prisma.journalEntry.findFirst({
      where: { organizationId: input.organizationId, sourceKey: input.sourceKey },
    })
    if (existing) return existing
  }

  validateJournalLines(input.lines, false)
  const filteredLines = input.lines.filter((l) => Math.round((l.debitAmount ?? 0) * 100) > 0 || Math.round((l.creditAmount ?? 0) * 100) > 0)
  if (filteredLines.length === 0) return null

  await assertPeriodOpen(prisma, input.organizationId, input.entryDate)
  const branch = await prisma.branch.findFirst({ where: { id: input.branchId, organizationId: input.organizationId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

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
    if (account.isHeader || account.isControlAccount || !account.allowManualPosting) {
      throw new AppError(`Account ${account.code} — ${account.name} is a control account and cannot receive direct postings`, 400, 'CONTROL_ACCOUNT_POSTING')
    }
  }

  const { resolvedLines, totalDebit, totalCredit, isBalanced } = validateJournalLines(filteredLines)

  const entryNo = await nextNumber(prisma, 'journalEntry', 'entryNo', 'JE', input.organizationId)

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

}

// Corrections to a posted entry are made by reversing it, never by editing
// or deleting its lines. Both the original and the reversal remain status
// "posted" — together they net to zero for every account involved, which is
// what keeps Trial Balance / Balance Sheet queries (which only look at
// status "posted") correct without special-casing voided activity.
export async function reverseJournalEntry(prisma: PrismaClient, journalEntryId: string, userId: string, reason: string, organizationId: string) {
  return financeTransaction(prisma, (tx) => reverseInTransaction(tx, journalEntryId, userId, reason, organizationId))
}

async function reverseInTransaction(prisma: PrismaClient, journalEntryId: string, userId: string, reason: string, organizationId: string) {
  await financeLock(prisma, `period:${organizationId}`)
  await financeLock(prisma, `reverse:${organizationId}:${journalEntryId}`)
  const original = await prisma.journalEntry.findUnique({ where: { id: journalEntryId }, include: { lines: true } })
  if (!original || original.organizationId !== organizationId) throw new AppError('Journal entry not found', 404, 'NOT_FOUND')
  if (original.status !== 'posted') throw new AppError('Only posted entries can be reversed', 400, 'INVALID_STATUS')
  if (original.reversedById) throw new AppError('This journal entry has already been reversed', 400, 'ALREADY_REVERSED')

  const reversalDate = new Date()
  await assertPeriodOpen(prisma, organizationId, reversalDate)

  const entryNo = await nextNumber(prisma, 'journalEntry', 'entryNo', 'JE', original.organizationId)

  const reversal = await prisma.journalEntry.create({
    data: {
      organizationId: original.organizationId,
      branchId: original.branchId,
      entryNo,
      entryDate: reversalDate,
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      sourceType: original.sourceType,
      sourceKey: `REVERSAL:${original.id}`,
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
