import { AccountingMappingKey, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'

// Current mappings, retained mapping history and standard reporting groups
// remain visible even after a mapped account is archived or replaced.
export async function roleAccountIds(db: PrismaClient, organizationId: string, key: AccountingMappingKey, reportingGroup: string) {
  const [current, history, grouped] = await Promise.all([
    db.accountingMapping.findUnique({ where: { organizationId_key: { organizationId, key } } }),
    db.accountingMappingAccount.findMany({ where: { organizationId, key } }),
    db.account.findMany({ where: { organizationId, reportingGroup }, select: { id: true } }),
  ])
  return [...new Set([...(current ? [current.accountId] : []), ...history.map((a) => a.accountId), ...grouped.map((a) => a.id)])]
}

export async function financialSummary(db: PrismaClient, organizationId: string, filters: { branchId?: string; fromDate?: string; toDate?: string }) {
  const from = filters.fromDate ? new Date(filters.fromDate) : undefined
  const to = filters.toDate ? new Date(filters.toDate) : undefined
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(filters.toDate!)) to.setUTCHours(23, 59, 59, 999)
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) throw new AppError('Invalid financial report date range', 400, 'VALIDATION_ERROR')
  const entryDate = { ...(from && { gte: from }), ...(to && { lte: to }) }
  const branch = filters.branchId ? { branchId: filters.branchId } : {}
  const entryWhere = { organizationId, status: 'posted', ...branch, ...((from || to) && { entryDate }) }
  const [accounts, sums, inputIds, outputIds, payableIds] = await Promise.all([
    db.account.findMany({ where: { organizationId } }),
    db.journalLine.groupBy({ by: ['accountId'], where: { journalEntry: entryWhere }, _sum: { debitAmount: true, creditAmount: true } }),
    roleAccountIds(db, organizationId, 'INPUT_VAT', 'Input VAT'),
    roleAccountIds(db, organizationId, 'OUTPUT_VAT', 'Output VAT'),
    roleAccountIds(db, organizationId, 'ACCOUNTS_PAYABLE', 'Accounts Payable'),
  ])
  const cents = (n: number) => Math.round(n * 100) / 100
  const accountMap = new Map(accounts.map((a) => [a.id, a]))
  let revenue = 0, expenses = 0, costOfSales = 0, otherIncome = 0, inputVat = 0, outputVat = 0
  for (const sum of sums) {
    const netDebit = Number(sum._sum.debitAmount ?? 0) - Number(sum._sum.creditAmount ?? 0)
    const account = accountMap.get(sum.accountId)
    if (account?.accountClass === 'REVENUE') {
      revenue -= netDebit
      if (account.reportingGroup === 'Other Income') otherIncome -= netDebit
    }
    if (account?.accountClass === 'EXPENSE') {
      expenses += netDebit
      if (['Cost of Sales', 'Wastage', 'Direct Costs'].includes(account.reportingGroup ?? '')) costOfSales += netDebit
    }
    if (inputIds.includes(sum.accountId)) inputVat += netDebit
    if (outputIds.includes(sum.accountId)) outputVat -= netDebit
  }
  const [salesCount, expenseCount, bills, payableBalance, payments] = await Promise.all([
    db.dailySale.count({ where: { organizationId, ...branch, status: 'approved', ...((from || to) && { saleDate: entryDate }) } }),
    db.expense.count({ where: { organizationId, ...branch, status: 'approved', source: { not: 'purchasing' }, ...((from || to) && { expenseDate: entryDate }) } }),
    db.bill.aggregate({ where: { organizationId, ...branch, status: { in: ['approved', 'partial', 'paid'] }, ...((from || to) && { billDate: entryDate }) }, _sum: { totalAmount: true }, _count: true }),
    db.journalLine.aggregate({ where: { accountId: { in: payableIds }, journalEntry: { organizationId, status: 'posted', ...branch, ...(to && { entryDate: { lte: to } }) } }, _sum: { debitAmount: true, creditAmount: true } }),
    db.payment.aggregate({ where: { organizationId, ...branch, journalEntryId: { not: null }, bill: { status: { in: ['approved', 'partial', 'paid'] } }, ...((from || to) && { paymentDate: entryDate }) }, _sum: { amount: true } }),
  ])
  return {
    revenue: { totalSales: cents(revenue), totalVatCollected: cents(outputVat), saleCount: salesCount },
    expenses: { totalExpenses: cents(expenses), vatPaid: cents(inputVat), expenseCount },
    payables: { totalBills: Number(bills._sum.totalAmount ?? 0), totalPaid: Number(payments._sum.amount ?? 0), balanceDue: cents(Number(payableBalance._sum.creditAmount ?? 0) - Number(payableBalance._sum.debitAmount ?? 0)), billCount: bills._count },
    grossProfit: cents(revenue - otherIncome - costOfSales),
    netProfit: cents(revenue - expenses),
  }
}
