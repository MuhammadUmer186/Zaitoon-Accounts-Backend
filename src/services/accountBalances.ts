import { PrismaClient } from '@prisma/client'

export interface BalanceFilters {
  branchId?: string
  fromDate?: Date
  toDate?: Date
}

export interface AccountBalance {
  debit: number
  credit: number
  balance: number
}

// Computes each account's balance purely from posted JournalLine rows — an
// Account never stores a manually maintained current balance (rule: all
// balances are derived, never cached). Uses a single grouped aggregate query
// rather than loading every line into memory, so this scales with account
// count, not transaction volume. Reused for "current balance" (no fromDate),
// year-to-date (fromDate = fiscal year start), and as-of-date reporting.
export async function computeAccountBalances(
  prisma: PrismaClient,
  organizationId: string,
  accountIds: string[],
  filters: BalanceFilters = {}
): Promise<Map<string, AccountBalance>> {
  const result = new Map<string, AccountBalance>()
  if (accountIds.length === 0) return result

  const entryWhere: Record<string, unknown> = { organizationId, status: 'posted' }
  if (filters.branchId) entryWhere.branchId = filters.branchId
  if (filters.fromDate || filters.toDate) {
    entryWhere.entryDate = {
      ...(filters.fromDate && { gte: filters.fromDate }),
      ...(filters.toDate && { lte: filters.toDate }),
    }
  }

  const [grouped, accounts] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accountIds }, journalEntry: entryWhere },
      _sum: { debitAmount: true, creditAmount: true },
    }),
    prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, normalBalance: true } }),
  ])

  const normalBalanceById = new Map(accounts.map((a) => [a.id, a.normalBalance]))

  for (const g of grouped) {
    const debit = Number(g._sum.debitAmount ?? 0)
    const credit = Number(g._sum.creditAmount ?? 0)
    const balance = normalBalanceById.get(g.accountId) === 'DEBIT' ? debit - credit : credit - debit
    result.set(g.accountId, { debit, credit, balance })
  }
  return result
}
