import { PrismaClient } from '@prisma/client'

export async function ledgerProfit(db: PrismaClient, organizationId: string, branchId?: string, entryDate?: Record<string, Date>) {
  const [accounts, sums] = await Promise.all([
    db.account.findMany({ where: { organizationId, accountClass: { in: ['REVENUE', 'EXPENSE'] } }, select: { id: true, accountClass: true, reportingGroup: true } }),
    db.journalLine.groupBy({ by: ['accountId'], where: { journalEntry: { organizationId, status: 'posted', ...(branchId && { branchId }), ...(entryDate && { entryDate }) } }, _sum: { debitAmount: true, creditAmount: true } }),
  ])
  const byId = new Map(accounts.map((account) => [account.id, account]))
  let revenue = 0, otherIncome = 0, expenses = 0, costOfSales = 0
  for (const sum of sums) {
    const account = byId.get(sum.accountId)
    const netDebit = Number(sum._sum.debitAmount ?? 0) - Number(sum._sum.creditAmount ?? 0)
    if (account?.accountClass === 'REVENUE') {
      revenue -= netDebit
      if (account.reportingGroup === 'Other Income') otherIncome -= netDebit
    }
    if (account?.accountClass === 'EXPENSE') {
      expenses += netDebit
      if (['Cost of Sales', 'Wastage', 'Direct Costs'].includes(account.reportingGroup ?? '')) costOfSales += netDebit
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100
  return { revenue: round(revenue), expenses: round(expenses), costOfSales: round(costOfSales), operatingExpenses: round(expenses - costOfSales), grossProfit: round(revenue - otherIncome - costOfSales), netProfit: round(revenue - expenses) }
}
