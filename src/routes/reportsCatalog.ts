import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { tryExportRows, sendRowsCsv, sendRowsExcel, sendRowsPdf } from '../utils/genericExport'
import { fiscalYearStartFor } from '../utils/fiscalYear'

// Mounted at the same /reports prefix as reports.ts — fills in the rest of
// the report catalog shown on the Reports page (daily-sales, branch-sales,
// branch-profit, cash-closing, expenses, supplier-payable, inventory-stock,
// wastage, audit-log, profit-loss, trial-balance, balance-sheet,
// vat-summary). general-ledger and dashboard/dashboard-v2 live in reports.ts.

const router = Router()
router.use(authenticate)

function dateRangeFilter(fromDate?: string, toDate?: string) {
  if (!fromDate && !toDate) return undefined
  return {
    ...(fromDate && { gte: new Date(fromDate) }),
    ...(toDate && { lte: new Date(toDate) }),
  }
}

// GET /reports/daily-sales — every sale in the period, one row per sale
router.get('/daily-sales', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const saleDate = dateRangeFilter(fromDate, toDate)

  const sales = await prisma.dailySale.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(saleDate && { saleDate }) },
    include: { branch: { select: { name: true } } },
    orderBy: { saleDate: 'asc' },
  })

  const rows = sales.map((s) => ({
    saleNo: s.saleNo,
    date: s.saleDate.toISOString().slice(0, 10),
    branch: s.branch.name,
    cash: s.cashAmount,
    card: s.cardAmount,
    delivery: s.deliveryAmount,
    bankTransfer: s.bankTransferAmount,
    other: s.otherAmount,
    subtotal: s.subtotal,
    vat: s.vatAmount,
    totalAmount: s.totalAmount,
    netAmount: s.netAmount,
    status: s.status,
  }))

  if (await tryExportRows(res, format, rows, 'daily-sales', 'Daily Sales Report')) return
  res.json({ data: rows })
})

// GET /reports/branch-sales — side-by-side branch sales comparison
router.get('/branch-sales', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const saleDate = dateRangeFilter(fromDate, toDate)

  const branches = await prisma.branch.findMany({
    where: { organizationId: orgId, isActive: true, ...(branchId && { id: branchId }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const rows = await Promise.all(
    branches.map(async (b) => {
      const agg = await prisma.dailySale.aggregate({
        where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(saleDate && { saleDate }) },
        _sum: { netAmount: true, vatAmount: true },
        _count: true,
      })
      const totalSales = agg._sum.netAmount ?? 0
      const saleCount = agg._count
      return {
        branch: b.name,
        saleCount,
        totalSales,
        totalVat: agg._sum.vatAmount ?? 0,
        avgSaleValue: saleCount > 0 ? Math.round((totalSales / saleCount) * 100) / 100 : 0,
      }
    })
  )
  rows.sort((a, b) => b.totalSales - a.totalSales)

  if (await tryExportRows(res, format, rows, 'branch-sales', 'Branch Sales Comparison')) return
  res.json({ data: rows })
})

// GET /reports/branch-profit — revenue minus expenses per branch
router.get('/branch-profit', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const saleDate = dateRangeFilter(fromDate, toDate)
  const expenseDate = dateRangeFilter(fromDate, toDate)

  const branches = await prisma.branch.findMany({
    where: { organizationId: orgId, isActive: true, ...(branchId && { id: branchId }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const rows = await Promise.all(
    branches.map(async (b) => {
      const [salesAgg, expAgg, billsAgg] = await Promise.all([
        prisma.dailySale.aggregate({
          where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(saleDate && { saleDate }) },
          _sum: { netAmount: true },
        }),
        prisma.expense.aggregate({
          where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(expenseDate && { expenseDate }) },
          _sum: { totalAmount: true },
        }),
        // Supplier purchases count as expenses here too
        prisma.bill.aggregate({
          where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(expenseDate && { billDate: expenseDate }) },
          _sum: { totalAmount: true },
        }),
      ])
      const totalSales = salesAgg._sum.netAmount ?? 0
      const totalExpenses = (expAgg._sum.totalAmount ?? 0) + (billsAgg._sum.totalAmount ?? 0)
      const profit = totalSales - totalExpenses
      return {
        branch: b.name,
        totalSales,
        totalExpenses,
        profit,
        profitMarginPct: totalSales > 0 ? Math.round((profit / totalSales) * 1000) / 10 : 0,
      }
    })
  )
  rows.sort((a, b) => b.profit - a.profit)

  if (await tryExportRows(res, format, rows, 'branch-profit', 'Branch Profit Report')) return
  res.json({ data: rows })
})

// GET /reports/cash-closing — daily cash reconciliation summary
router.get('/cash-closing', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const closingDate = dateRangeFilter(fromDate, toDate)

  const closings = await prisma.cashClosing.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), ...(closingDate && { closingDate }) },
    include: { branch: { select: { name: true } } },
    orderBy: { closingDate: 'desc' },
  })

  const rows = closings.map((c) => ({
    closingNo: c.closingNo,
    date: c.closingDate.toISOString().slice(0, 10),
    branch: c.branch.name,
    openingCash: c.openingCash,
    cashSales: c.cashSales,
    expectedCash: c.expectedCash,
    actualCashCounted: c.actualCashCounted,
    difference: c.difference,
    differenceType: c.differenceType,
    status: c.status,
  }))

  if (await tryExportRows(res, format, rows, 'cash-closing', 'Cash Closing Report')) return
  res.json({ data: rows })
})

// GET /reports/expenses — all expenses by category and branch
router.get('/expenses', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const expenseDate = dateRangeFilter(fromDate, toDate)

  const expenses = await prisma.expense.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(expenseDate && { expenseDate }) },
    include: { branch: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: { expenseDate: 'desc' },
  })

  const rows = expenses.map((e) => ({
    expenseNo: e.expenseNo,
    date: e.expenseDate.toISOString().slice(0, 10),
    branch: e.branch.name,
    category: e.category.name,
    description: e.description,
    amount: e.amount,
    vat: e.vatAmount,
    totalAmount: e.totalAmount,
    paymentMethod: e.paymentMethod,
    status: e.status,
  }))

  if (await tryExportRows(res, format, rows, 'expenses', 'Expense Report')) return
  res.json({ data: rows })
})

// GET /reports/purchases — every supplier bill in the period (Purchasing
// module one-shot entries, Purchase Order receipts, and manually created
// bills alike), one row per bill
router.get('/purchases', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const billDate = dateRangeFilter(fromDate, toDate)

  const bills = await prisma.bill.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(billDate && { billDate }) },
    include: { supplier: { select: { name: true } }, branch: { select: { name: true } } },
    orderBy: { billDate: 'desc' },
  })

  const rows = bills.map((b) => ({
    purchaseNo: b.billNo,
    date: b.billDate.toISOString().slice(0, 10),
    supplier: b.supplier.name,
    branch: b.branch.name,
    subtotal: b.subtotal,
    vat: b.vatAmount,
    totalAmount: b.totalAmount,
    paidAmount: b.paidAmount,
    balanceDue: b.balanceDue,
    status: b.status,
    source: b.source,
  }))

  if (await tryExportRows(res, format, rows, 'purchases', 'Purchase Report')) return
  res.json({ data: rows })
})

// GET /reports/supplier-payable — outstanding bills with aging analysis
router.get('/supplier-payable', async (req: Request, res: Response) => {
  const { branchId, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const now = new Date()

  const bills = await prisma.bill.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { notIn: ['paid', 'void'] } },
    include: { supplier: { select: { name: true } }, branch: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  })

  const rows = bills.map((b) => {
    const daysOverdue = Math.max(0, Math.floor((now.getTime() - b.dueDate.getTime()) / (1000 * 60 * 60 * 24)))
    const agingBucket = daysOverdue === 0 ? 'Current' : daysOverdue <= 30 ? '1-30 days' : daysOverdue <= 60 ? '31-60 days' : daysOverdue <= 90 ? '61-90 days' : '90+ days'
    return {
      billNo: b.billNo,
      supplier: b.supplier.name,
      branch: b.branch.name,
      billDate: b.billDate.toISOString().slice(0, 10),
      dueDate: b.dueDate.toISOString().slice(0, 10),
      totalAmount: b.totalAmount,
      paidAmount: b.paidAmount,
      balanceDue: b.balanceDue,
      daysOverdue,
      agingBucket,
    }
  })

  if (await tryExportRows(res, format, rows, 'supplier-payable', 'Supplier Payable Report')) return
  res.json({ data: rows })
})

// GET /reports/inventory-stock — current stock levels and valuation
router.get('/inventory-stock', async (req: Request, res: Response) => {
  const { branchId, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const [stocks, org] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...(branchId && { branchId }) },
      include: { item: true, branch: { select: { name: true } } },
      orderBy: [{ branch: { name: 'asc' } }, { item: { name: 'asc' } }],
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
  ])
  const globalThreshold = org?.lowStockThreshold ?? null

  const rows = stocks.map((s) => ({
    itemCode: s.item.code,
    item: s.item.name,
    branch: s.branch.name,
    unit: s.item.unit,
    quantityOnHand: s.quantityOnHand,
    averageCost: s.averageCost,
    totalValue: s.totalValue,
    isLowStock: s.quantityOnHand < (globalThreshold ?? s.reorderPoint),
  }))

  if (await tryExportRows(res, format, rows, 'inventory-stock', 'Inventory Stock Report')) return
  res.json({ data: rows })
})

// GET /reports/wastage — inventory losses by branch and item
router.get('/wastage', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const reportDate = dateRangeFilter(fromDate, toDate)

  const reports = await prisma.wastageReport.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), ...(reportDate && { reportDate }) },
    include: { branch: { select: { name: true } }, items: { include: { item: true } } },
    orderBy: { reportDate: 'desc' },
  })

  const rows = reports.flatMap((r) =>
    r.items.map((wi) => ({
      reportDate: r.reportDate.toISOString().slice(0, 10),
      branch: r.branch.name,
      item: wi.item.name,
      quantity: wi.quantity,
      unitCost: wi.unitCost,
      totalValue: wi.totalValue,
      reason: wi.reason ?? '',
      status: r.status,
    }))
  )

  if (await tryExportRows(res, format, rows, 'wastage', 'Wastage Report')) return
  res.json({ data: rows })
})

// GET /reports/audit-log — complete user action history
router.get('/audit-log', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const createdAt = dateRangeFilter(fromDate, toDate)

  const logs = await prisma.auditLog.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), ...(createdAt && { createdAt }) },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  const rows = logs.map((l) => ({
    date: l.createdAt.toISOString().slice(0, 19).replace('T', ' '),
    user: l.userName || l.userEmail,
    action: l.action,
    module: l.module,
    resource: l.resourceRef ?? l.resourceType ?? '',
  }))

  if (await tryExportRows(res, format, rows, 'audit-log', 'Audit Log Report')) return
  res.json({ data: rows })
})

// GET /reports/profit-loss — income vs expenses for a period
// Expense reportingGroups that roll up into Cost of Sales rather than
// Operating Expenses on the P&L — mirrors the standard 5xxx chart section.
const COST_OF_SALES_GROUPS = new Set(['Cost of Sales', 'Wastage', 'Direct Costs'])

// GET /reports/profit-loss — built entirely from posted JournalLine data
// (never combined with operational-table totals, which could double-count
// or diverge from what's actually posted to the ledger).
router.get('/profit-loss', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  const entryDate = dateRangeFilter(fromDate, toDate)
  if (entryDate) entryWhere.entryDate = entryDate

  const accounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE', accountClass: { in: ['REVENUE', 'EXPENSE'] } },
    select: { id: true, name: true, accountClass: true, reportingGroup: true, normalBalance: true },
  })
  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: entryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })

  const sums = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const s = sums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    sums.set(l.accountId, s)
  }

  const rows = accounts
    .map((a) => {
      const s = sums.get(a.id) ?? { debit: 0, credit: 0 }
      const balance = a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit
      return { ...a, balance }
    })
    .filter((r) => Math.abs(r.balance) > 0.005)

  const otherIncomeRows = rows.filter((r) => r.accountClass === 'REVENUE' && r.reportingGroup === 'Other Income')
  const discountRows = rows.filter((r) => r.accountClass === 'REVENUE' && r.reportingGroup === 'Discounts')
  const grossRevenueRows = rows.filter((r) => r.accountClass === 'REVENUE' && r.reportingGroup !== 'Other Income' && r.reportingGroup !== 'Discounts')
  const costOfSalesRows = rows.filter((r) => r.accountClass === 'EXPENSE' && COST_OF_SALES_GROUPS.has(r.reportingGroup ?? ''))
  const opexRows = rows.filter((r) => r.accountClass === 'EXPENSE' && !COST_OF_SALES_GROUPS.has(r.reportingGroup ?? ''))

  const grossRevenue = grossRevenueRows.reduce((s, r) => s + r.balance, 0)
  const discounts = discountRows.reduce((s, r) => s + r.balance, 0)
  const netRevenue = grossRevenue - discounts
  const costOfSales = costOfSalesRows.reduce((s, r) => s + r.balance, 0)
  const grossProfit = netRevenue - costOfSales
  const operatingExpenses = opexRows.reduce((s, r) => s + r.balance, 0)
  const otherIncome = otherIncomeRows.reduce((s, r) => s + r.balance, 0)
  const netProfit = grossProfit - operatingExpenses + otherIncome

  const lines_ = [
    { name: 'Revenue', amount: 0, type: 'header' as const },
    ...grossRevenueRows.map((r) => ({ name: r.name, amount: r.balance, type: 'line' as const })),
    ...(discounts > 0.005 ? [{ name: 'Sales Returns and Discounts', amount: -discounts, type: 'line' as const }] : []),
    { name: 'Net Revenue', amount: netRevenue, type: 'subtotal' as const },
    { name: 'Cost of Sales', amount: 0, type: 'header' as const },
    ...costOfSalesRows.map((r) => ({ name: r.name, amount: r.balance, type: 'line' as const })),
    { name: 'Gross Profit', amount: grossProfit, type: 'subtotal' as const },
    { name: 'Operating Expenses', amount: 0, type: 'header' as const },
    ...opexRows.map((r) => ({ name: r.name, amount: r.balance, type: 'line' as const })),
    ...(Math.abs(otherIncome) > 0.005 ? [{ name: 'Other Income', amount: otherIncome, type: 'line' as const }] : []),
    { name: 'Net Profit', amount: netProfit, type: 'subtotal' as const },
  ]

  const report = { revenue: netRevenue, expenses: costOfSales + operatingExpenses, grossProfit, netProfit, lines: lines_ }

  if (format === 'csv') { sendRowsCsv(res, lines_.filter((l) => l.type !== 'header'), 'profit-loss'); return }
  if (format === 'excel') { await sendRowsExcel(res, lines_.filter((l) => l.type !== 'header'), 'profit-loss', 'Profit & Loss'); return }
  if (format === 'pdf') { sendRowsPdf(res, lines_.filter((l) => l.type !== 'header'), 'profit-loss', 'Profit & Loss Statement'); return }
  res.json(report)
})

// GET /reports/trial-balance — every active account's posted activity
// (Assets/Liabilities/Equity/Revenue/Expense — same as /accounting/trial-balance)
router.get('/trial-balance', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  const entryDate = dateRangeFilter(fromDate, toDate)
  if (entryDate) entryWhere.entryDate = entryDate

  const accounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE' },
    orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
  })
  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: entryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })

  const sums = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const s = sums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    sums.set(l.accountId, s)
  }

  const rows = accounts
    .map((a) => {
      const s = sums.get(a.id) ?? { debit: 0, credit: 0 }
      return { code: a.code, name: a.name, debit: s.debit, credit: s.credit }
    })
    .filter((r) => r.debit > 0 || r.credit > 0)

  if (await tryExportRows(res, format, rows, 'trial-balance', 'Trial Balance')) return
  res.json({ accounts: rows })
})

// GET /reports/balance-sheet — Assets, Liabilities & Equity as of a date.
// Current Year Earnings is computed live from Revenue − Expenses for the
// fiscal year to date rather than stored, since there is no year-end
// closing-entry workflow yet; it is reported here but excluded from the
// real Equity account list to avoid double-counting if that account exists.
router.get('/balance-sheet', async (req: Request, res: Response) => {
  const { branchId, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const asOf = toDate ? new Date(toDate) : new Date()

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted', entryDate: { lte: asOf } }
  if (branchId) entryWhere.branchId = branchId

  const [org, accounts] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { fiscalYearStart: true } }),
    prisma.account.findMany({
      where: { organizationId: orgId, status: 'ACTIVE', accountClass: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
      orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
    }),
  ])

  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: entryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })

  const sums = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const s = sums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    sums.set(l.accountId, s)
  }

  const rows = accounts.map((a) => {
    const s = sums.get(a.id) ?? { debit: 0, credit: 0 }
    const balance = a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit
    return { code: a.code, name: a.name, accountType: a.accountClass, reportingGroup: a.reportingGroup, balance }
  }).filter((r) => r.balance !== 0)

  const assets = rows.filter((r) => r.accountType === 'ASSET')
  const liabilities = rows.filter((r) => r.accountType === 'LIABILITY')
  // Exclude a real "Current Year Earnings" account (if configured) from the
  // ledger-derived Equity rows — its balance is computed live below instead.
  const equity = rows.filter((r) => r.accountType === 'EQUITY' && r.reportingGroup !== 'Current Year Earnings')

  const fyStart = fiscalYearStartFor(asOf, org?.fiscalYearStart ?? '01-01')
  const pnlEntryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted', entryDate: { gte: fyStart, lte: asOf } }
  if (branchId) pnlEntryWhere.branchId = branchId

  const pnlAccounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE', accountClass: { in: ['REVENUE', 'EXPENSE'] } },
    select: { id: true, accountClass: true, normalBalance: true },
  })
  const pnlLines = await prisma.journalLine.findMany({
    where: { journalEntry: pnlEntryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })
  const pnlSums = new Map<string, { debit: number; credit: number }>()
  for (const l of pnlLines) {
    const s = pnlSums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    pnlSums.set(l.accountId, s)
  }
  let revenueTotal = 0
  let expenseTotal = 0
  for (const a of pnlAccounts) {
    const s = pnlSums.get(a.id) ?? { debit: 0, credit: 0 }
    const balance = a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit
    if (a.accountClass === 'REVENUE') revenueTotal += balance
    else expenseTotal += balance
  }
  const currentYearEarnings = revenueTotal - expenseTotal

  const totalAssets = assets.reduce((s, r) => s + r.balance, 0)
  const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0)
  const totalEquity = equity.reduce((s, r) => s + r.balance, 0) + currentYearEarnings

  const equityRows = [
    ...equity.map(({ code, name, balance }) => ({ code, name, balance })),
    { code: '3300', name: 'Current Year Earnings', balance: currentYearEarnings },
  ]

  const report = {
    asOf: asOf.toISOString(),
    assets: assets.map(({ code, name, balance }) => ({ code, name, balance })),
    liabilities: liabilities.map(({ code, name, balance }) => ({ code, name, balance })),
    equity: equityRows,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netPosition: totalAssets - totalLiabilities,
    // Assets = Liabilities + Equity — the frontend surfaces this flag directly
    // rather than silently trusting the arithmetic always lines up.
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  }

  const flatRows = [
    ...report.assets.map((a) => ({ section: 'Asset', code: a.code, name: a.name, balance: a.balance })),
    ...report.liabilities.map((l) => ({ section: 'Liability', code: l.code, name: l.name, balance: l.balance })),
    ...report.equity.map((e) => ({ section: 'Equity', code: e.code, name: e.name, balance: e.balance })),
  ]

  if (format === 'csv') { sendRowsCsv(res, flatRows, 'balance-sheet'); return }
  if (format === 'excel') { await sendRowsExcel(res, flatRows, 'balance-sheet', 'Balance Sheet'); return }
  if (format === 'pdf') { sendRowsPdf(res, flatRows, 'balance-sheet', 'Balance Sheet'); return }
  res.json(report)
})

// GET /reports/vat-summary — tax collected (sales) vs paid (expenses/bills)
router.get('/vat-summary', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  const entryDate = dateRangeFilter(fromDate, toDate)
  if (entryDate) entryWhere.entryDate = entryDate

  // Sourced from Output VAT / Input VAT account activity (captured at
  // posting time) rather than raw vatAmount fields on operational records —
  // changing an account's default tax rate later never alters these figures.
  const [outputMapping, inputMapping] = await Promise.all([
    prisma.accountingMapping.findUnique({ where: { organizationId_key: { organizationId: orgId, key: 'OUTPUT_VAT' } } }),
    prisma.accountingMapping.findUnique({ where: { organizationId_key: { organizationId: orgId, key: 'INPUT_VAT' } } }),
  ])

  const [outputLines, inputLines] = await Promise.all([
    outputMapping
      ? prisma.journalLine.findMany({ where: { accountId: outputMapping.accountId, journalEntry: entryWhere }, select: { debitAmount: true, creditAmount: true } })
      : Promise.resolve([]),
    inputMapping
      ? prisma.journalLine.findMany({
          where: { accountId: inputMapping.accountId, journalEntry: entryWhere },
          select: { debitAmount: true, creditAmount: true, journalEntry: { select: { sourceType: true } } },
        })
      : Promise.resolve([]),
  ])

  const vatCollected = outputLines.reduce((s, l) => s + Number(l.creditAmount) - Number(l.debitAmount), 0)

  let vatPaidExpenses = 0
  let vatPaidBills = 0
  let vatPaidOther = 0
  for (const l of inputLines) {
    const net = Number(l.debitAmount) - Number(l.creditAmount)
    if (l.journalEntry.sourceType === 'EXPENSE') vatPaidExpenses += net
    else if (l.journalEntry.sourceType === 'BILL') vatPaidBills += net
    else vatPaidOther += net
  }
  const vatPaid = vatPaidExpenses + vatPaidBills + vatPaidOther

  const report = {
    fromDate: fromDate || null,
    toDate: toDate || null,
    vatCollected,
    vatPaidExpenses,
    vatPaidBills,
    vatPaid,
    netVatPayable: vatCollected - vatPaid,
    configured: { outputVat: !!outputMapping, inputVat: !!inputMapping },
  }

  const flatRows = [
    { line: 'VAT Collected (Output VAT)', amount: vatCollected },
    { line: 'VAT Paid (Expenses)', amount: vatPaidExpenses },
    { line: 'VAT Paid (Supplier Bills)', amount: vatPaidBills },
    ...(vatPaidOther !== 0 ? [{ line: 'VAT Paid (Other)', amount: vatPaidOther }] : []),
    { line: 'Net VAT Payable', amount: report.netVatPayable },
  ]

  if (format === 'csv') { sendRowsCsv(res, flatRows, 'vat-summary'); return }
  if (format === 'excel') { await sendRowsExcel(res, flatRows, 'vat-summary', 'VAT Summary'); return }
  if (format === 'pdf') { sendRowsPdf(res, flatRows, 'vat-summary', 'VAT / Tax Summary'); return }
  res.json(report)
})

export default router
